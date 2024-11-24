"use client";

import { useEffect, useCallback, useState, useRef } from "react";
import { RealtimeClient } from "@openai/realtime-api-beta";
import { ItemType } from "@openai/realtime-api-beta/dist/lib/client.js";
import { WavRecorder, WavStreamPlayer } from "@/lib/wavtools/index.js";

const client = new RealtimeClient({
  apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY,
  dangerouslyAllowAPIKeyInBrowser: true,
});

const wavRecorder = new WavRecorder({ sampleRate: 24000 });
const wavStreamPlayer = new WavStreamPlayer({ sampleRate: 24000 });

export default function Home() {
  // サーバーと接続しているか、切断しているか
  const [isConnected, setIsConnected] = useState(false);

  // itemはメッセージデータのオブジェクト。発言履歴やrole、status、typeなどを含みます。
  const [items, setItems] = useState<ItemType[]>([]);

  // 音声を可視化するために波系
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveformData.length) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    // 波形を描画
    ctx.strokeStyle = "#4A90E2"; // 青色の波形
    ctx.lineWidth = 2;
    ctx.beginPath();

    const sliceWidth = width / waveformData.length;
    waveformData.forEach((value, index) => {
      const x = sliceWidth * index;
      const y = height / 2 + (value / 256) * (height / 2); // 値を高さにマッピング
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();
  }, [waveformData]);

  const connectConversation = useCallback(async () => {
    // 状態を変更
    setIsConnected(true);
    setItems(client.conversation.getItems());

    await wavRecorder.begin();

    await wavStreamPlayer.connect();

    // clientを接続
    await client.connect();

    client.sendUserMessageContent([
      {
        type: `input_text`,
        text: `こんにちは！`,
      },
    ]);

    console.log(client.conversation.getItems());
    if (client.getTurnDetectionType() === "server_vad") {
      await wavRecorder.record((data) => {
        client.appendInputAudio(data.mono);

        // 波形データを更新
        const normalizedData = Array.from(data.mono, (sample) =>
          Math.abs(sample * 128)
        ); // 0-255に正規化
        setWaveformData(normalizedData);
      });
    }
  }, []);

  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setItems([]);

    client.disconnect();

    await wavRecorder.end();

    wavStreamPlayer.interrupt();

    setWaveformData([]); // 波形をリセット
  }, []);

  useEffect(() => {
    drawWaveform();
  }, [waveformData, drawWaveform]);

  useEffect(() => {
    // AIへの指示をセット
    client.updateSession({
      instructions: "あなたは役にたつAIアシスタントです",
    });
    // 音声toテキスト翻訳のモデルをセット
    client.updateSession({ input_audio_transcription: { model: "whisper-1" } });
    // ユーザーが話終えたことをサーバー側で判断する'server_vad'に設定
    client.updateSession({ turn_detection: { type: "server_vad" } });

    client.updateSession({ voice: "alloy" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on("error", (event: any) => console.error(event));

    client.on("conversation.interrupted", () => {
      console.log("interrupted");
      const trackSampleOffset = wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        client.cancelResponse(trackId, offset);
      }
    });

    // 必要
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on("conversation.updated", async ({ item, delta }: any) => {
      console.log("convesation.updated");
      const items = client.conversation.getItems();
      console.log("items", items);
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      if (item.status === "completed" && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });

    // 会話のオブジェクトはclient.conversationに含まれているので、抽出してitemsにセットする
    setItems(client.conversation.getItems());

    return () => {
      // cleanup; resets to defaults
      client.reset();
    };
  }, []);

  return (
    <div className="relative bg-gray-100 min-h-screen flex flex-col items-center">
      {/* 背景の波形 */}
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0 w-full h-full z-0"
        width={800}
        height={600}
      />

      <header className="bg-green-500 text-white w-full text-center py-4 z-10">
        <h1 className="text-xl font-bold">AO Talk</h1>
      </header>
      <main
        className="flex-1 w-full max-w-md mx-auto p-4 overflow-y-auto z-10"
        style={{ paddingBottom: "80px" }}
      >
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <div
              key={item.id}
              className={`p-4 max-w-[80%] rounded-lg ${
                item.role === "user"
                  ? "bg-blue-500 text-white self-end"
                  : "bg-gray-300 text-black self-start"
              }`}
            >
              <p>{item.formatted.transcript}</p>
            </div>
          ))}
        </div>
      </main>
      <footer className="fixed bottom-0 left-0 w-full bg-white border-t p-4 flex justify-center z-10">
        {isConnected ? (
          <button
            onClick={disconnectConversation}
            className="px-4 py-2 bg-red-500 text-white rounded-lg"
          >
            停止
          </button>
        ) : (
          <button
            onClick={connectConversation}
            className="px-4 py-2 bg-green-500 text-white rounded-lg"
          >
            録音開始
          </button>
        )}
      </footer>
    </div>
  );
}

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
  const animationRef = useRef<number | null>(null);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveformData.length) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    // Canvasのクリア
    ctx.clearRect(0, 0, width, height);

    // 波形のスタイル設定
    ctx.strokeStyle = "#ff6f6f"; // 背景色の補色
    ctx.lineWidth = 4;

    // 波形を描画
    ctx.beginPath();

    const centerY = height / 2; // 中央ライン
    const step = Math.ceil(waveformData.length / canvas.width); // データの間引き
    const amp = canvas.height / 2 - 10; // 波形の振幅（上下の最大高さ）

    for (let x = 0; x < canvas.width; x++) {
      const index = x * step;
      const sample = waveformData[index] || 0; // 現在の音声データ
      const y = centerY - (sample * amp) / 10; // 波の高さ

      // 最初の点を moveTo、それ以降は lineTo
      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();

    // 次のフレームを描画
    animationRef.current = requestAnimationFrame(drawWaveform);
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
        const normalizedData = Array.from(
          data.mono,
          (sample) => Math.abs(sample / 32768) // Normalize to range [0, 1]
        );
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

    // 波形を消去する処理
    setWaveformData([]);
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }, []);

  useEffect(() => {
    drawWaveform();
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [waveformData, drawWaveform]);

  useEffect(() => {
    // AIへの指示をセット
    client.updateSession({
      instructions:
        "あなたは役にたつAIアシスタントです。ただ、しばしば質問者の意図を間違えることがあります。質問者の意図を汲み取れないことを考慮した上で、相手に不快感を与えずに会話をしてください。3回以上同じ回答をしそうな場合はあなたが上手く解釈できていない可能性があるため、相手に謝罪し話題を必ず変えてください。",
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
      const audio: Int16Array = delta?.audio;
      if (delta?.audio) {
        const normalizedData = Array.from(
          audio,
          (sample) => Math.abs(sample / 32768) // Normalize to range [0, 1]
        );
        setWaveformData(normalizedData);
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
    <div
      className="relative bg-gray-100 min-h-screen flex flex-col items-center"
      style={{
        background: "linear-gradient(to bottom, #a2d9ff, #d4f1ff)",
      }}
    >
      {/* 背景中央に固定表示するCanvas */}
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 1, // 他のUIの上に表示
        }}
      ></canvas>

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
                  ? "bg-green-500 text-black self-end"
                  : "bg-white text-black self-start"
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
            会話開始
          </button>
        )}
      </footer>
    </div>
  );
}

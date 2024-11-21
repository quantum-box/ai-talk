"use client";

import Image from "next/image";
import { useEffect, useCallback, useState } from "react";
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
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
  }, []);

  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setItems([]);

    client.disconnect();

    await wavRecorder.end();

    wavStreamPlayer.interrupt();
  }, []);

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
    <div className="grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20 font-[family-name:var(--font-geist-sans)]">
      <main className="flex flex-col gap-8 row-start-2 items-center sm:items-start">
        <Image
          className="dark:invert"
          src="https://nextjs.org/icons/next.svg"
          alt="Next.js logo"
          width={180}
          height={38}
          priority
        />
        <div>
          {items.map((item) => {
            return (
              <div key={item.id}>
                {item.role}：{JSON.stringify(item.formatted.transcript)}
              </div>
            );
          })}
        </div>

        <div>
          {isConnected ? (
            <button onClick={disconnectConversation}>停止</button>
          ) : (
            <button onClick={connectConversation}>録音開始</button>
          )}
        </div>
      </main>
    </div>
  );
}

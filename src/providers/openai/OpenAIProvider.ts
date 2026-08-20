import OpenAI from "openai";
import { env } from "../../config/env.js";
import type { LLMProvider, LLMChatParams, LLMChatResult } from "../llm/LLMProvider.js";
import type { ImageGenProvider, ImageGenParams, ImageGenResult } from "../image/ImageGenProvider.js";

/**
 * Single OpenAI-backed class implementing both the LLMProvider (chat/vision,
 * for understanding + planning) and ImageGenProvider (gpt-image-1, for
 * character/product bible generation) interfaces. Kept as one class since
 * both capabilities come from the same vendor/API key in v1.
 */
export class OpenAIProvider implements LLMProvider, ImageGenProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }

  async chat(params: LLMChatParams): Promise<LLMChatResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (params.systemPrompt) {
      messages.push({ role: "system", content: params.systemPrompt });
    }
    for (const m of params.messages) {
      if (m.images?.length) {
        messages.push({
          role: m.role,
          content: [
            { type: "text", text: m.content },
            ...m.images.map((img) => ({
              type: "image_url" as const,
              image_url: { url: img.url ?? `data:image/png;base64,${img.base64}` },
            })),
          ],
        } as OpenAI.Chat.ChatCompletionMessageParam);
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const completion = await this.client.chat.completions.create({
      model: params.model ?? "gpt-4o",
      messages,
      response_format: params.responseFormat === "json" ? { type: "json_object" } : undefined,
    });

    return {
      text: completion.choices[0]?.message?.content ?? "",
      raw: completion,
    };
  }

  async generate(params: ImageGenParams): Promise<ImageGenResult> {
    const result = await this.client.images.generate({
      model: "gpt-image-1",
      prompt: params.prompt,
      n: params.n,
      size: (params.size as "1024x1024" | "1536x1024" | "1024x1536") ?? "1024x1024",
    });

    const images = (result.data ?? []).map((d) => Buffer.from(d.b64_json ?? "", "base64"));
    return { images };
  }
}

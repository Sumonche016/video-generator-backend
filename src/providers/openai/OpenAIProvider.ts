import OpenAI, { toFile } from "openai";
import { runtimeConfig } from "../../config/runtimeConfig.js";
import type { LLMProvider, LLMChatParams, LLMChatResult } from "../llm/LLMProvider.js";
import type { ImageGenProvider, ImageGenParams, ImageGenResult } from "../image/ImageGenProvider.js";
import { createSerialQueue } from "../../utils/serialQueue.js";

// gpt-image-1 has a low per-minute rate limit (e.g. 5 images/min on many
// accounts). Serializing calls means simultaneous "Generate" clicks across
// characters queue up and wait their turn instead of all firing at once and
// blowing through the limit together.
const imageGenQueue = createSerialQueue();

/**
 * Single OpenAI-backed class implementing both the LLMProvider (chat/vision,
 * for understanding + planning) and ImageGenProvider (gpt-image-1, for
 * character/product bible generation) interfaces. Kept as one class since
 * both capabilities come from the same vendor/API key in v1.
 */
export class OpenAIProvider implements LLMProvider, ImageGenProvider {
  private client: OpenAI;

  constructor() {
    // maxRetries lets the SDK auto-retry 429s with backoff (it honors the
    // API's Retry-After hint) instead of surfacing the error to the user.
    this.client = new OpenAI({ apiKey: runtimeConfig.OPENAI_API_KEY, maxRetries: 5 });
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
    return imageGenQueue(async () => {
      const size = (params.size as "1024x1024" | "1536x1024" | "1024x1536") ?? "1024x1024";

      // With reference images (e.g. the user's uploaded product photo), use
      // images.edit so generation is actually conditioned on what was
      // uploaded — plain images.generate only sees the text prompt and will
      // invent visual details it was never shown.
      const result = params.referenceImages?.length
        ? await this.client.images.edit({
            model: "gpt-image-1",
            image: await Promise.all(
              params.referenceImages.map((ref, i) =>
                toFile(ref.buffer, `reference-${i}.png`, { type: ref.mimeType ?? "image/png" })
              )
            ),
            prompt: params.prompt,
            n: params.n,
            size,
          })
        : await this.client.images.generate({
            model: "gpt-image-1",
            prompt: params.prompt,
            n: params.n,
            size,
          });

      const images = (result.data ?? []).map((d) => Buffer.from(d.b64_json ?? "", "base64"));
      return { images };
    });
  }
}

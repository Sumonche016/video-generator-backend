export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: { url?: string; base64?: string }[];
}

export interface LLMChatParams {
  systemPrompt?: string;
  messages: LLMMessage[];
  responseFormat?: "text" | "json";
  model?: string;
}

export interface LLMChatResult {
  text: string;
  raw: unknown;
}

export interface LLMProvider {
  chat(params: LLMChatParams): Promise<LLMChatResult>;
}

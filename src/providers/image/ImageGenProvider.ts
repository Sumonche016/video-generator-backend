export interface ImageGenParams {
  prompt: string;
  // Actual image bytes to condition generation on (e.g. the user's uploaded
  // product photo) — without these, the model only has the text prompt to
  // go on and will hallucinate visual details it was never shown.
  referenceImages?: { buffer: Buffer; mimeType?: string }[];
  n: number;
  size?: string;
}

export interface ImageGenResult {
  images: Buffer[];
}

export interface ImageGenProvider {
  generate(params: ImageGenParams): Promise<ImageGenResult>;
}

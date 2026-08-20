export interface ImageGenParams {
  prompt: string;
  referenceImages?: { path?: string; base64?: string }[];
  n: number;
  size?: string;
}

export interface ImageGenResult {
  images: Buffer[];
}

export interface ImageGenProvider {
  generate(params: ImageGenParams): Promise<ImageGenResult>;
}

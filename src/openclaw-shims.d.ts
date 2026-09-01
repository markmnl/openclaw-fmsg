declare module "openclaw/plugin-sdk/outbound-media" {
  export type OutboundMediaLoadOptions = {
    mediaAccess?: unknown;
  };

  export function loadOutboundMediaFromUrl(
    mediaUrl: string,
    options?: {
      maxBytes?: number;
      mediaAccess?: unknown;
      mediaLocalRoots?: readonly string[];
      mediaReadFile?: (filePath: string) => Promise<Buffer>;
      optimizeImages?: boolean;
    },
  ): Promise<{
    buffer: Buffer;
    contentType?: string;
    fileName?: string;
    kind?: string;
  }>;
}

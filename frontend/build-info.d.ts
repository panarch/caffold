// What TypeScript modules use from build-info.js, which the Rust build
// writes beside the frontend modules it serves.

export const BUILD_INFO: Readonly<{
  id: string;
  label: string;
  version: string;
  commit: string;
  number: number;
}>;

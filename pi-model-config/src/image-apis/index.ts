import type { ProviderImages } from "@earendil-works/pi-ai";
import { generateImages as generateDashscopeImages } from "./dashscope.ts";
import { generateImages as generateGeminiImages } from "./gemini.ts";
import { generateImages as generateOpenaiImages } from "./openai.ts";
import { generateImages as generateXaiImages } from "./xai.ts";

/** Extension-owned APIs absent from Pi 1.2.0's host image catalog. */
export const SELF_IMAGE_IMPLEMENTATIONS: Readonly<Record<string, ProviderImages>> = {
  "openai-images": { generateImages: generateOpenaiImages },
  "gemini-images": { generateImages: generateGeminiImages },
  "xai-images": { generateImages: generateXaiImages },
  "dashscope-images": { generateImages: generateDashscopeImages },
};

export const SELF_IMAGE_APIS: ReadonlySet<string> = new Set(Object.keys(SELF_IMAGE_IMPLEMENTATIONS));

import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import { apiKey, dataUrl, failedImageResult, fetchFor, imageResult, normalizeBaseUrl, promptFromContext, records, requestHeaders, resolveImageBaseUrl, responseJson } from "./common.ts";

export async function generateImages(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions, activeSecrets: readonly string[] = []): Promise<AssistantImages> {
  try {
    const baseUrl = resolveImageBaseUrl(model.api, model.baseUrl);
    if (!baseUrl) throw new Error("Gemini Images requires a Base URL");
    const key = apiKey(options);
    if (!key) throw new Error("Gemini Images requires an API key");
    const response = await fetchFor(options)(`${normalizeBaseUrl(baseUrl, "/v1beta")}/models/${encodeURIComponent(model.id)}:generateContent`, {
      method: "POST",
      headers: requestHeaders(model, options, { "x-goog-api-key": key }),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptFromContext(context) }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { imageSize: "1K" } },
      }),
      signal: options?.signal,
    });
    const json = await responseJson(response, options, activeSecrets) as Record<string, unknown>;
    const result = imageResult(model);
    for (const candidate of records(json.candidates)) {
      const content = candidate.content as Record<string, unknown> | undefined;
      for (const part of records(content?.parts)) {
        const inline = (part.inline_data ?? part.inlineData) as Record<string, unknown> | undefined;
        const encoded = typeof inline?.data === "string" ? inline.data : undefined;
        const mime = inline?.mime_type ?? inline?.mimeType;
        const mimeType = typeof mime === "string" ? mime : "image/png";
        if (encoded) result.output.push({ type: "image", data: dataUrl(mimeType, encoded), mimeType });
      }
    }
    if (!result.output.length) throw new Error("Gemini Images returned no inline image data");
    return result;
  } catch (error) {
    return failedImageResult(model, error, options, activeSecrets);
  }
}

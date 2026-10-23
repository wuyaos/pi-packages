import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import { apiKey, dataUrl, failedImageResult, fetchFor, imageResult, normalizeBaseUrl, promptFromContext, records, requestHeaders, resolveImageBaseUrl, responseJson } from "./common.ts";

export async function generateImages(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions, activeSecrets: readonly string[] = []): Promise<AssistantImages> {
  try {
    const baseUrl = resolveImageBaseUrl(model.api, model.baseUrl);
    if (!baseUrl) throw new Error("xAI Images requires a Base URL");
    const key = apiKey(options);
    if (!key) throw new Error("xAI Images requires an API key");
    const response = await fetchFor(options)(`${normalizeBaseUrl(baseUrl, "/v1")}/images/generations`, {
      method: "POST",
      headers: requestHeaders(model, options, { authorization: `Bearer ${key}` }),
      body: JSON.stringify({ model: model.id, prompt: promptFromContext(context), n: 1, response_format: "b64_json" }),
      signal: options?.signal,
    });
    const json = await responseJson(response, options, activeSecrets) as Record<string, unknown>;
    const result = imageResult(model);
    for (const item of records(json.data)) {
      const encoded = typeof item.b64_json === "string" ? item.b64_json : undefined;
      if (encoded) result.output.push({ type: "image", data: dataUrl("image/jpeg", encoded), mimeType: "image/jpeg" });
    }
    if (!result.output.length) throw new Error("xAI Images returned no base64 image data");
    return result;
  } catch (error) {
    return failedImageResult(model, error, options, activeSecrets);
  }
}

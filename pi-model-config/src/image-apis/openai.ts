import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import { apiKey, dataUrl, downloadImageUrl, failedImageResult, fetchFor, imageResult, normalizeBaseUrl, promptFromContext, records, requestHeaders, resolveImageBaseUrl, responseJson } from "./common.ts";

/** OpenAI Images API; this is a small request-local adapter, not Pi's host image pipeline. */
export async function generateImages(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions, activeSecrets: readonly string[] = []): Promise<AssistantImages> {
  try {
    const baseUrl = resolveImageBaseUrl(model.api, model.baseUrl);
    if (!baseUrl) throw new Error("OpenAI Images requires a Base URL");
    const key = apiKey(options);
    if (!key) throw new Error("OpenAI Images requires an API key");
    const isGptImage = model.id.toLowerCase().startsWith("gpt-image");
    const body: Record<string, unknown> = { model: model.id, prompt: promptFromContext(context), n: 1 };
    if (isGptImage) body.output_format = "png";
    else body.response_format = "b64_json";
    const response = await fetchFor(options)(`${normalizeBaseUrl(baseUrl, "/v1")}/images/generations`, {
      method: "POST",
      headers: requestHeaders(model, options, { authorization: `Bearer ${key}` }),
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    const json = await responseJson(response, options, activeSecrets) as Record<string, unknown>;
    const result = imageResult(model);
    const fetcher = fetchFor(options);
    for (const item of records(json.data)) {
      const encoded = typeof item.b64_json === "string" && item.b64_json ? item.b64_json : undefined;
      if (encoded) {
        result.output.push({ type: "image", data: dataUrl("image/png", encoded), mimeType: "image/png" });
        continue;
      }
      if (typeof item.url === "string" && item.url) {
        const image = await downloadImageUrl(item.url, { fetch: fetcher, signal: options?.signal });
        result.output.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
    }
    if (!result.output.length) throw new Error("OpenAI Images returned no usable b64_json or url image data");
    return result;
  } catch (error) {
    return failedImageResult(model, error, options, activeSecrets);
  }
}

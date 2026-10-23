import type { AssistantImages, ImageModel, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import { apiKey, downloadImageUrl, failedImageResult, fetchFor, imageResult, normalizeBaseUrl, promptFromContext, records, requestHeaders, resolveImageBaseUrl, responseJson } from "./common.ts";

/** DashScope multimodal-generation synchronous endpoint. Deliberately does not set X-DashScope-Async. */
export async function generateImages(model: ImageModel<string>, context: ImagesContext, options?: ImagesOptions, activeSecrets: readonly string[] = []): Promise<AssistantImages> {
  try {
    const baseUrl = resolveImageBaseUrl(model.api, model.baseUrl);
    if (!baseUrl) throw new Error("DashScope Images requires a Base URL");
    const key = apiKey(options);
    if (!key) throw new Error("DashScope Images requires an API key");
    const fetcher = fetchFor(options);
    const response = await fetcher(`${normalizeBaseUrl(baseUrl, "/api/v1")}/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: requestHeaders(model, options, { authorization: `Bearer ${key}` }),
      body: JSON.stringify({
        model: model.id,
        input: { messages: [{ role: "user", content: [{ text: promptFromContext(context) }] }] },
      }),
      signal: options?.signal,
    });
    const json = await responseJson(response, options, activeSecrets) as Record<string, unknown>;
    const output = json.output as Record<string, unknown> | undefined;
    const firstChoice = records(output?.choices)[0];
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    const result = imageResult(model);
    for (const part of records(message?.content)) {
      const imageField = part.image;
      const url = typeof imageField === "string"
        ? imageField
        : imageField && typeof imageField === "object" && !Array.isArray(imageField) && typeof (imageField as Record<string, unknown>).url === "string"
          ? String((imageField as Record<string, unknown>).url)
          : undefined;
      if (!url) continue;
      const image = await downloadImageUrl(url, { fetch: fetcher, signal: options?.signal });
      result.output.push({ type: "image", mimeType: image.mimeType, data: image.data });
    }
    if (!result.output.length) throw new Error("DashScope Images returned no downloadable image URLs");
    return result;
  } catch (error) {
    return failedImageResult(model, error, options, activeSecrets);
  }
}

import { describe, expect, test } from "bun:test";
import { normalizeAvailableModels } from "../src/models/available-normalizer";
import { normalizeCursorModels } from "../src/models/usable-normalizer";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "../src/shared/constants";

describe("Cursor model normalization", () => {
  test("uses explicit AvailableModels context variants", () => {
    const models = normalizeAvailableModels([{
      name: "composer-2",
      clientDisplayName: "Composer 2",
      serverModelName: "composer-2",
      parameterDefinitions: [
        {
          id: "context",
          parameterType: {
            enumParameter: {
              values: [
                { value: "128k", displayName: "128K" },
                { value: "1m", displayName: "1M" },
              ],
            },
          },
        },
        {
          id: "reasoning",
          parameterType: {
            enumParameter: {
              values: [{ value: "medium" }, { value: "high" }],
            },
          },
        },
      ],
      variants: [
        {
          parameterValues: [
            { id: "context", value: "128k" },
            { id: "reasoning", value: "medium" },
          ],
          legacySlug: "composer-2-medium",
          isDefaultNonMaxConfig: true,
        },
        {
          parameterValues: [
            { id: "context", value: "128k" },
            { id: "reasoning", value: "high" },
          ],
          legacySlug: "composer-2-high",
        },
        {
          parameterValues: [
            { id: "context", value: "1m" },
            { id: "reasoning", value: "medium" },
          ],
          legacySlug: "composer-2-1m-medium",
          isDefaultMaxConfig: true,
        },
      ],
    }]);

    expect(models.map((model) => [model.id, model.contextWindow])).toEqual([
      ["composer-2", 128_000],
      ["composer-2-1m", 1_000_000],
    ]);
    expect(models[0]?.variants).toHaveProperty("high");
  });

  test("groups Cursor reasoning-effort values as OpenCode variants", () => {
    const models = normalizeAvailableModels([{
      name: "gemini-3.8-flash",
      clientDisplayName: "Gemini 3.8 Flash",
      serverModelName: "gemini-3.8-flash",
      parameterDefinitions: [
        {
          id: "reasoning-effort",
          parameterType: {
            enumParameter: {
              values: [
                { value: "medium", displayName: "Medium" },
                { value: "high", displayName: "High" },
              ],
            },
          },
        },
      ],
      variants: [
        {
          parameterValues: [{ id: "reasoning-effort", value: "medium" }],
          legacySlug: "gemini-3.8-flash",
          isDefaultNonMaxConfig: true,
        },
        {
          parameterValues: [{ id: "reasoning-effort", value: "high" }],
          legacySlug: "gemini-3.8-flash-high",
        },
      ],
    }]);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      reasoning: true,
    });
    expect(Object.keys(models[0]?.variants ?? {})).toEqual(["medium", "high"]);
    expect(models[0]?.defaultSelection.parameters).toEqual([
      { id: "reasoning-effort", value: "medium" },
    ]);
    expect(models[0]?.variants.high?.parameters).toEqual([
      { id: "reasoning-effort", value: "high" },
    ]);
  });

  test("folds a sibling High catalog name into the base model's variants", () => {
    const models = normalizeAvailableModels([
      {
        name: "gemini-3.7-flash",
        clientDisplayName: "Gemini 3.7 Flash",
        serverModelName: "gemini-3.7-flash",
        parameterDefinitions: [
          {
            id: "reasoning",
            parameterType: {
              enumParameter: {
                values: [{ value: "low" }, { value: "medium" }],
              },
            },
          },
        ],
        variants: [
          {
            parameterValues: [{ id: "reasoning", value: "medium" }],
            legacySlug: "gemini-3.7-flash",
            isDefaultNonMaxConfig: true,
          },
          {
            parameterValues: [{ id: "reasoning", value: "low" }],
            legacySlug: "gemini-3.7-flash-low",
          },
        ],
      },
      {
        name: "gemini-3.7-flash-high",
        clientDisplayName: "Gemini 3.7 Flash",
        serverModelName: "gemini-3.7-flash-high",
      },
    ]);

    expect(models.map((model) => model.id)).toEqual(["gemini-3.7-flash"]);
    expect(Object.keys(models[0]?.variants ?? {}).sort()).toEqual([
      "high",
      "low",
      "medium",
    ]);
    expect(models[0]?.variants.high?.publicId).toBe("gemini-3.7-flash-high");
    expect(models[0]?.defaultSelection.publicId).toBe("gemini-3.7-flash");
  });

  test("groups usable-model effort variants with configured fallback limits", () => {
    const models = normalizeCursorModels([
      {
        modelId: "claude-opus-low",
        displayName: "Claude Opus Low",
        thinkingDetails: {},
      },
      {
        modelId: "claude-opus-high",
        displayName: "Claude Opus High",
        thinkingDetails: {},
      },
    ]);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "claude-opus",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      variants: {
        low: expect.any(Object),
        high: expect.any(Object),
      },
    });
  });
});

import {
  Integration,
  Model,
  Plugin,
  Provider,
} from "@opencode/plugin";
import { Money } from "@opencode/schema/money";
import {
  CURSOR_SELECTION_HEADER,
  encodeCursorModelSelection,
  type CursorModel,
} from "../model-selection.js";
import { estimateModelCost } from "../provider/pricing.js";
import {
  CURSOR_INTEGRATION_ID,
  type DisposableRegistration,
} from "./integration.js";

const CURSOR_PROVIDER_ID = Provider.ID.make(
  CURSOR_INTEGRATION_ID,
);
const CURSOR_INTEGRATION = Integration.ID.make(
  CURSOR_INTEGRATION_ID,
);
const CURSOR_PACKAGE = `aisdk:${new URL("./provider.js", import.meta.url).href}`;

export interface CursorCatalogState {
  models: readonly CursorModel[];
}

type CatalogContext = {
  provider: Pick<Plugin.Context["provider"], "transform">;
};

export function createCursorCatalogState(
  models: readonly CursorModel[],
): CursorCatalogState {
  return { models };
}

export function updateCursorCatalogState(
  state: CursorCatalogState,
  models: readonly CursorModel[],
): void {
  state.models = models;
}

export async function registerCursorCatalog(
  context: CatalogContext,
  state: CursorCatalogState,
): Promise<DisposableRegistration> {
  return context.provider.transform((editor) => {
    const models: Model.Info[] = state.models.map((cursorModel) => {
      const modelID = Model.ID.make(cursorModel.id);
      const cost = estimateModelCost(cursorModel.id);
      return {
        ...Model.Info.default(CURSOR_PROVIDER_ID, modelID),
        name: cursorModel.name,
        modelID,
        capabilities: {
          tools: true,
          input: ["text", "image"],
          output: ["text"],
        },
        headers: {
          [CURSOR_SELECTION_HEADER]: encodeCursorModelSelection(
            cursorModel.defaultSelection,
          ),
        },
        variants: Object.entries(cursorModel.variants).map(
          ([id, selection]) => ({
            id: Model.VariantID.make(id),
            headers: {
              [CURSOR_SELECTION_HEADER]:
                encodeCursorModelSelection(selection),
            },
          }),
        ),
        time: { released: 0 },
        cost: [
          {
            input: Money.USDPerMillionTokens.make(cost.input),
            output: Money.USDPerMillionTokens.make(cost.output),
            cache: {
              read: Money.USDPerMillionTokens.make(cost.cache.read),
              write: Money.USDPerMillionTokens.make(cost.cache.write),
            },
          },
        ],
        status: "active",
        enabled: true,
        limit: {
          context: cursorModel.contextWindow,
          output: cursorModel.maxTokens,
        },
      };
    });

    if (models.length === 0) {
      const connectModelID = Model.ID.make("connect");
      models.push({
        ...Model.Info.default(CURSOR_PROVIDER_ID, connectModelID),
        name: "Connect Cursor to load models",
        modelID: connectModelID,
        capabilities: {
          tools: false,
          input: ["text"],
          output: ["text"],
        },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 1, output: 1 },
      });
    }

    editor.add({
      info: {
        ...Provider.Info.empty(CURSOR_PROVIDER_ID),
        name: "Cursor",
        integrationID: CURSOR_INTEGRATION,
        activation: state.models.length === 0 ? "enabled" : "auto",
        package: CURSOR_PACKAGE,
      },
      models,
    });
  });
}

/** `GET /v1/models` and `GET /v1/models/{id}`: the one model there is (spec 061, D12). */
import type { FastifyInstance } from "fastify";
import { notFound } from "../errors.js";
import { sendError } from "../http.js";
import { MODEL_NAME } from "../response-record.js";

const MODEL = { id: MODEL_NAME, object: "model", created: 0, owned_by: "pipiclaw" } as const;

export function registerModelRoutes(app: FastifyInstance): void {
	app.get("/v1/models", async () => ({ object: "list", data: [MODEL] }));
	app.get<{ Params: { id: string } }>("/v1/models/:id", async (request, reply) => {
		if (request.params.id !== MODEL_NAME) return sendError(reply, notFound(`Model ${request.params.id}`));
		return MODEL;
	});
}

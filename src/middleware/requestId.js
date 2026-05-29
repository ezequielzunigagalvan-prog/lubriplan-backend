import { randomUUID } from "crypto";
import { requestStore } from "../lib/requestStore.js";

export function requestId(req, res, next) {
  const id = req.headers["x-request-id"] || randomUUID();
  req.id = id;
  res.set("x-request-id", id);
  requestStore.run({ requestId: id }, () => next());
}

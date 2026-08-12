import { describe, expect, it } from "vitest";
import { parseTaskEventName } from "../src/tasks/task-events.js";

describe("task event naming helpers", () => {
	it("parses task-owned event names for the current channel only", () => {
		expect(parseTaskEventName("task.dm_1.weekly.checkin", "dm_1")).toEqual({ id: "weekly", use: "checkin" });
		expect(parseTaskEventName("task.dm_1.weekly.checkin.json", "dm_1")).toEqual({
			id: "weekly",
			use: "checkin",
		});
		expect(parseTaskEventName("task.dm_2.weekly.checkin", "dm_1")).toBeUndefined();
		expect(parseTaskEventName("task.dm_1.bad", "dm_1")).toBeUndefined();
	});
});

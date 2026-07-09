import { describe, expect, it } from "vitest";
import {
	isTaskCheckinEvent,
	isTaskScheduleEvent,
	parseTaskEventName,
	taskEventPrefix,
	taskScheduleEventFilename,
	taskScheduleEventName,
} from "../src/shared/task-events.js";

describe("task event naming helpers", () => {
	it("builds task-owned event names", () => {
		expect(taskEventPrefix("dm_1", "weekly")).toBe("task.dm_1.weekly.");
		expect(taskScheduleEventName("dm_1", "weekly")).toBe("task.dm_1.weekly.schedule");
		expect(taskScheduleEventFilename("dm_1", "weekly")).toBe("task.dm_1.weekly.schedule.json");
	});

	it("parses task-owned event names for the current channel only", () => {
		expect(parseTaskEventName("task.dm_1.weekly.checkin", "dm_1")).toEqual({ id: "weekly", use: "checkin" });
		expect(parseTaskEventName("task.dm_1.weekly.checkin.json", "dm_1")).toEqual({
			id: "weekly",
			use: "checkin",
		});
		expect(parseTaskEventName("task.dm_2.weekly.checkin", "dm_1")).toBeUndefined();
		expect(parseTaskEventName("task.dm_1.bad", "dm_1")).toBeUndefined();
	});

	it("classifies schedule and checkin events by use and type", () => {
		expect(isTaskScheduleEvent({ use: "schedule", event: { type: "periodic" } })).toBe(true);
		expect(isTaskScheduleEvent({ use: "agentmux", event: { type: "periodic" } })).toBe(false);
		expect(isTaskCheckinEvent({ use: "checkin", event: { type: "one-shot" } })).toBe(true);
		expect(isTaskCheckinEvent({ use: "checkin", event: { type: "periodic" } })).toBe(false);
	});
});

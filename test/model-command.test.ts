import { describe, expect, it } from "vitest";
import { parseModelCommand } from "../src/model-command.js";

describe("model command parsing", () => {
  it("accepts only standalone model commands", () => {
    expect(parseModelCommand("/models")).toEqual({ kind: "list" });
    expect(parseModelCommand("/model gpt-fast")).toEqual({ kind: "set", model: "gpt-fast" });
    expect(parseModelCommand("/model default")).toEqual({ kind: "reset" });
    expect(parseModelCommand("/new --model=gpt-fast")).toEqual({
      kind: "new",
      model: "gpt-fast",
    });
    expect(parseModelCommand("/new continue the audit --model gpt-fast with tests")).toEqual({
      kind: "new",
      model: "gpt-fast",
    });
  });

  it("does not consume slash-command text embedded in prose", () => {
    expect(parseModelCommand("please explain /models to me")).toBeUndefined();
    expect(parseModelCommand("/model gpt-fast please")).toBeUndefined();
    expect(parseModelCommand("hello /new --model gpt-fast")).toBeUndefined();
  });
});

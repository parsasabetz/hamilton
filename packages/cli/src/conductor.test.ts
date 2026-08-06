import { describe, expect, test } from "bun:test"
import { conductorPrompt, conductorTitle } from "./conductor.ts"

describe("conductorTitle", () => {
  test("formats Conductor | <name>", () => {
    expect(conductorTitle("hamilton")).toBe("Conductor | hamilton")
  })
})

describe("conductorPrompt", () => {
  test("first line is the title", () => {
    const prompt = conductorPrompt("hamilton")
    expect(prompt.split("\n")[0]).toBe("Conductor | hamilton")
  })

  test("mentions plan mode and the project name", () => {
    const prompt = conductorPrompt("hamilton")
    expect(prompt).toContain("plan mode")
    expect(prompt).toContain("hamilton")
  })
})

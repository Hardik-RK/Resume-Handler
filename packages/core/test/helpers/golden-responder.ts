import type { HttpClient, HttpRequest, HttpResponse } from "../../src/index.js";

/** The deterministic provider the golden whole-pipeline runs were recorded with (see scripts/gen-golden.py). */
export class GoldenResponder implements HttpClient {
  readonly requests: Array<{ kind: "score" | "extract"; model: string; vision: boolean }> = [];
  static readonly PEOPLE: Record<string, [string, string, string]> = {
    A: ["Test Person A", "cand0@example.com", "9876543200"],
    B: ["Test Person B", "cand1@example.com", "9876543201"],
    C: ["Test Person C", "cand2@example.com", "9876543202"],
    D: ["Test Person D", "cand3@example.com", "9876543200"],
  };

  async post(_url: string, request: HttpRequest): Promise<HttpResponse> {
    const body = request.body as any;
    const isScore = body.response_format?.type === "json_object";
    const content = body.messages[1].content;
    this.requests.push({ kind: isScore ? "score" : "extract", model: body.model, vision: Array.isArray(content) });
    const wrap = (data: unknown): HttpResponse => ({
      status: 200,
      headers: {},
      text: JSON.stringify({
        id: "gen-x",
        model: "resp/model",
        choices: [{ message: { content: JSON.stringify(data) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.001 },
      }),
    });
    if (isScore) {
      const resume = String(content).split("Candidate Resume:")[1] ?? "";
      return wrap(
        resume.includes("Kubernetes experience")
          ? { score: 80, verdict: "pass", missing_critical: [], reason: "good fit" }
          : { score: 20, verdict: "reject", missing_critical: ["Kubernetes"], reason: "gap" },
      );
    }
    const props = body.response_format.json_schema.schema.properties as Record<string, { type: string | string[] }>;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) data[k] = (Array.isArray(v.type) ? v.type : [v.type]).includes("array") ? [] : null;
    if (Array.isArray(content)) {
      Object.assign(data, { name: "SCAN PERSON", email: "scan@example.com", phone: "+91 98765 43299", location: "Pune", graduation: "2020 - B.E" });
    } else {
      const m = /Test Person ([A-Z])/.exec(content);
      if (m) {
        const [name, email, phone] = GoldenResponder.PEOPLE[m[1]!]!;
        Object.assign(data, {
          name, email, phone, location: "Bengaluru, India", graduation: "2021 - B.Tech",
          skill_tags: ["Python"], skill_details: [{ name: "Python", proficiency: null, years: null }],
        });
      }
    }
    return wrap(data);
  }
}

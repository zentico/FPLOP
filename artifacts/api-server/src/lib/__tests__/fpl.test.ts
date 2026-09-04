import { describe, expect, it, vi } from "vitest";
import { fplFetch } from "../fpl";

const response = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("FPL API retries", () => {
  it("recovers from a temporary 503", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, { id: 4573508 }));
    const sleep = vi.fn(async () => {});

    await expect(
      fplFetch<{ id: number }>("/entry/4573508/", { fetchImpl, sleep }),
    ).resolves.toEqual({ id: 4573508 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [750]]);
  });

  it("does not retry a permanent 404", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(404));
    const sleep = vi.fn(async () => {});

    await expect(
      fplFetch("/entry/999999999/", { fetchImpl, sleep }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports a persistent transient failure after three attempts", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(503));
    const sleep = vi.fn(async () => {});

    await expect(
      fplFetch("/entry/4573508/", { fetchImpl, sleep }),
    ).rejects.toMatchObject({
      status: 503,
      message: "FPL API 503 for /entry/4573508/",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
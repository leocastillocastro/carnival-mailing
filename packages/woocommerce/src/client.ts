import type { WooCustomer, WooOrder } from "./types.js";

export interface WooClientConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface PageParams {
  page?: number;
  perPage?: number;
}

const PER_PAGE_DEFAULT = 50;

export function createWooClient(config: WooClientConfig) {
  const authHeader =
    "Basic " + Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");

  async function request<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<{ data: T; totalPages: number }> {
    const url = new URL(`/wp-json/wc/v3${path}`, config.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, {
      headers: { Authorization: authHeader, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`WooCommerce API error ${res.status} on ${path}: ${await res.text()}`);
    }
    const totalPages = Number(res.headers.get("X-WP-TotalPages") ?? "1");
    const data = (await res.json()) as T;
    return { data, totalPages };
  }

  return {
    async listCustomers({ page = 1, perPage = PER_PAGE_DEFAULT }: PageParams = {}) {
      return request<WooCustomer[]>("/customers", { page, per_page: perPage, orderby: "id", order: "asc" });
    },

    async getCustomer(id: number) {
      const { data } = await request<WooCustomer>(`/customers/${id}`);
      return data;
    },

    async listOrders({ page = 1, perPage = PER_PAGE_DEFAULT }: PageParams = {}, status: string = "any") {
      return request<WooOrder[]>("/orders", { page, per_page: perPage, status, orderby: "id", order: "asc" });
    },

    async getOrder(id: number) {
      const { data } = await request<WooOrder>(`/orders/${id}`);
      return data;
    },

    /** Iterates every page of a list endpoint until it runs out of pages. */
    async *paginateAll<T>(
      fetchPage: (params: PageParams) => Promise<{ data: T[]; totalPages: number }>,
    ): AsyncGenerator<T[]> {
      let page = 1;
      while (true) {
        const { data, totalPages } = await fetchPage({ page });
        if (data.length === 0) return;
        yield data;
        if (page >= totalPages) return;
        page += 1;
      }
    },
  };
}

export type WooClient = ReturnType<typeof createWooClient>;

// Subset of the WooCommerce REST API v3 fields this project actually consumes.
// See: https://woocommerce.github.io/woocommerce-rest-api-docs/

export interface WooCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  date_created: string;
  date_modified: string;
  billing?: {
    city?: string;
    postcode?: string;
  };
}

export interface WooOrderLineItem {
  id: number;
  name: string;
  product_id: number;
  sku: string;
  quantity: number;
  price: number;
}

export interface WooShippingLine {
  // The stable machine key ("free_shipping", "flat_rate", "local_pickup") —
  // method_title is free text that WooCommerce lets you reword per shipping
  // zone/method (e.g. "Recogida local" vs "Recogida Local"), so it's not
  // reliable to segment or group by.
  method_id: string;
  method_title: string;
}

export interface WooOrder {
  id: number;
  status: string;
  currency: string;
  total: string;
  date_created: string;
  date_completed: string | null;
  customer_id: number;
  billing: {
    email: string;
    first_name: string;
    last_name: string;
  };
  line_items: WooOrderLineItem[];
  shipping_lines?: WooShippingLine[];
}

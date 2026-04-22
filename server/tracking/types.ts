// Normalized tracking model. Adapters translate provider-specific responses into this.

export type TrackingMode = "ocean" | "air";

export type TrackingMilestoneType =
  | "booking_confirmed"
  | "gate_in"
  | "loaded"
  | "departed"
  | "transshipment"
  | "arrived"
  | "discharged"
  | "gate_out"
  | "delivered"
  | "delayed_alert"
  | "manifest"
  | "received"
  | "in_flight"
  | "landed"
  | "customs_cleared"
  | "other";

export interface TrackingMilestone {
  type: TrackingMilestoneType;
  description: string;
  location?: string | null;
  occurred_at: string; // ISO timestamp
}

export interface NormalizedTracking {
  provider: string;
  fetched_at: string;
  status: "scheduled" | "in_transit" | "delayed" | "arrived" | "delivered" | "cancelled" | "unknown";
  carrier?: string | null;
  vessel_or_flight?: string | null;
  scheduled_departure?: string | null;
  actual_departure?: string | null;
  scheduled_arrival?: string | null;
  actual_arrival?: string | null;
  delay_days?: number | null;
  milestones: TrackingMilestone[];
  raw: unknown;
}

export interface TrackingQuery {
  mode: TrackingMode;
  containerNumber?: string | null;
  bookingNumber?: string | null;
  awbNumber?: string | null;
  flightNumber?: string | null;
  carrierScac?: string | null;
}

export interface TrackingProvider {
  name: string;
  /** True if the provider is configured (has the API key it needs). */
  isConfigured(): boolean;
  /** True if the provider can handle the given query (mode + identifiers). */
  supports(q: TrackingQuery): boolean;
  fetch(q: TrackingQuery): Promise<NormalizedTracking>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly status?: number, public readonly raw?: unknown) {
    super(message);
    this.name = "ProviderError";
  }
}

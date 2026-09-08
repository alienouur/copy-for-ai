// Stripe Payment Link for Copy for AI Pro (one-time $9).
export const PRO_CHECKOUT_URL = "https://buy.stripe.com/cNieVf5Me70wcA4fdS2Ji00";

// License server (server/): verifies the Stripe purchase and returns a signed key.
export const LICENSE_API_URL = "https://copyforai-license.onrender.com";

// Public half of the license signing key; keys are verified offline with WebCrypto.
export const LICENSE_PUBLIC_KEY_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "NJGNnf7K-q_oz64eFV1BsWJFymN9lbkOjlgmQFwJBVw",
  y: "wqk-buuqkvFuLzGewKXmaNrcf_D396170oeatKx6PPg",
};

export const LANDING_URL = "https://copyforai.onrender.com";
export const SUPPORT_EMAIL = "alienouur@gmail.com";

export const FREE_PRO_TRIALS = 5;
export const MAX_HISTORY = 30;
export const HISTORY_ITEM_CHAR_LIMIT = 150_000;

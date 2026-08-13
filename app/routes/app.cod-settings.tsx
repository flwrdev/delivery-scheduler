// COD Settings — merchant-editable knobs for the COD eligibility function +
// the ₱ COD fee, without redeploys. Writes:
//   - the `$app:cod-eligibility` / `function-configuration` metafield on the
//     app's PaymentCustomization (read live by the checkout function),
//   - the COD Fee variant's price (SKU COD-FEE — the amount the orders/create
//     webhook adds to COD orders),
//   - the payment customization's enabled flag,
//   - two shop metafields mirroring the fee for the surfaces that cannot read a
//     variant price: `$app:cod`/`fee` (checkout UI extensions) and
//     `custom`/`cod_fee` (Liquid, i.e. the order confirmation email).
// None of these touch delivery state — see api.md ("COD settings" caveat).
// Per ADR-11, the action always answers 200 + { ok, ... }.

import { useCallback, useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { COD_FEE_SKU, findCodFeeVariant } from "../services/cod-fee.server";

const CONFIG_NAMESPACE = "$app:cod-eligibility";
const CONFIG_KEY = "function-configuration";

const LOAD_QUERY = `#graphql
  query CodSettingsLoad {
    paymentCustomizations(first: 25) {
      nodes {
        id
        title
        enabled
        metafield(namespace: "${CONFIG_NAMESPACE}", key: "${CONFIG_KEY}") {
          jsonValue
        }
      }
    }
  }
`;

const CURRENT_CONFIG_QUERY = `#graphql
  query CodSettingsCurrentConfig($id: ID!) {
    paymentCustomization(id: $id) {
      metafield(namespace: "${CONFIG_NAMESPACE}", key: "${CONFIG_KEY}") {
        jsonValue
      }
    }
  }
`;

const SET_CONFIG_MUTATION = `#graphql
  mutation CodSettingsSetConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

const TOGGLE_MUTATION = `#graphql
  mutation CodSettingsToggle($id: ID!, $enabled: Boolean!) {
    paymentCustomizationUpdate(id: $id, paymentCustomization: { enabled: $enabled }) {
      userErrors {
        field
        message
      }
    }
  }
`;

const FEE_PRICE_MUTATION = `#graphql
  mutation CodSettingsFeePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors {
        field
        message
      }
    }
  }
`;

const SHOP_ID_QUERY = `#graphql
  query CodSettingsShopId {
    shop {
      id
    }
  }
`;

// Namespace/key must match the [[extensions.metafields]] declaration in BOTH
// thank-you extensions — that is how the storefront reads it.
export const COD_FEE_METAFIELD_NAMESPACE = "$app:cod";
export const COD_FEE_METAFIELD_KEY = "fee";

// The SAME fee, mirrored a second time under a plain (non app-reserved)
// namespace so LIQUID can read it — `$app:cod` resolves to `app--<id>--cod`,
// which only this app can see, and Liquid is not this app.
//
// This copy exists for the Order confirmation NOTIFICATION, which today
// hardcodes "+ ₱70.00" and adds 70 into its own subtotal/total. It cannot read
// the fee off the order either: Shopify sends that email seconds BEFORE the
// orders/create webhook adds the COD Fee line (prod #4097 — email 20:48:59,
// line item 20:49:04), so at render time the order does not have the fee yet.
// A shop metafield is the only value that is correct at that instant.
export const COD_FEE_LIQUID_NAMESPACE = "custom";
export const COD_FEE_LIQUID_KEY = "cod_fee";

// Releasit's OWN copy of the fee, in centavos. Not ours, deliberately written.
//
// The order confirmation email's COD block is Releasit's — its Liquid draws the
// `COD Fee ₱70` row and resolves the `{order_total}` placeholder in the
// merchant's message from THIS metafield, not from the order. The arithmetic is
// right and the number is wrong: at send time the order is still pre-edit
// (₱1,226 on #4097), Releasit adds its own `commission`, and ₱70 gave ₱1,296
// when the customer owed ₱1,311. Feed it the real fee and both the row and the
// total come out correct with no template edit at all.
//
// Releasit's fee ENGINE stays off (`_cod_fee.other_settings.isFeeEnabled`
// false) — turning it on would charge the fee a second time. This writes only
// the display amount.
//
// Last writer wins: saving inside the Releasit app overwrites this. Re-saving
// /app/cod-settings puts it back.
export const RELEASIT_FEE_NAMESPACE = "_cod_fee";
export const RELEASIT_FEE_KEY = "commission";

/** Releasit stores the fee as an integer number of centavos ("7000" = ₱70). */
export function toReleasitCentavos(feeAmount: number): string {
  return String(Math.round(feeAmount * 100));
}

type CodConfig = {
  minimumAmount?: number;
  maximumAmount?: number;
  /** Display-only copy for the checkout function's paymentMethodRename. */
  feeAmount?: number;
  [key: string]: unknown;
};

export const loader = async ({ request }: { request: Request }) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(LOAD_QUERY);
  const result = (await response.json()) as {
    data?: {
      paymentCustomizations?: {
        nodes?: Array<{
          id: string;
          title: string;
          enabled: boolean;
          metafield?: { jsonValue?: CodConfig } | null;
        }>;
      };
    };
  };

  const customizations = result.data?.paymentCustomizations?.nodes ?? [];
  const customization =
    customizations.find((node) => node.metafield?.jsonValue) ??
    customizations.find((node) => /cod|cash on delivery/i.test(node.title)) ??
    null;
  const config: CodConfig = customization?.metafield?.jsonValue ?? {};

  // Same exact-SKU lookup the orders/create webhook uses, so this page always
  // prices the variant that actually gets charged (services/cod-fee.server.ts).
  const { variant: feeVariant, errors: feeErrors } =
    await findCodFeeVariant(admin);
  if (feeErrors.length > 0) {
    console.warn(`[cod-settings] fee variant lookup: ${feeErrors.join("; ")}`);
  }

  return {
    customization: customization
      ? {
          id: customization.id,
          title: customization.title,
          enabled: customization.enabled,
        }
      : null,
    config: {
      minimumAmount: config.minimumAmount ?? null,
      maximumAmount: config.maximumAmount ?? null,
    },
    feeVariant: feeVariant
      ? {
          id: feeVariant.id,
          productId: feeVariant.productId,
          price: feeVariant.price,
        }
      : null,
    // The client component must not import COD_FEE_SKU from the .server module
    // (build error: server-only module referenced by client) — pass it as data.
    feeSku: COD_FEE_SKU,
  };
};

export const action = async ({ request }: { request: Request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const customizationId = String(form.get("customizationId") ?? "");
  const enabled = form.get("enabled") === "true";
  const minimumRaw = String(form.get("minimumAmount") ?? "").trim();
  const maximumRaw = String(form.get("maximumAmount") ?? "").trim();
  const feeRaw = String(form.get("feeAmount") ?? "").trim();
  const variantId = String(form.get("variantId") ?? "");
  const productId = String(form.get("productId") ?? "");

  const errors: string[] = [];
  const parseAmount = (raw: string, label: string): number | null => {
    if (raw === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${label}: dapat positibong numero.`);
      return null;
    }
    return value;
  };

  const minimumAmount = parseAmount(minimumRaw, "Minimum");
  const maximumAmount = parseAmount(maximumRaw, "Maximum");
  const feeAmount = parseAmount(feeRaw, "COD fee");
  if (
    minimumAmount !== null &&
    maximumAmount !== null &&
    maximumAmount < minimumAmount
  ) {
    errors.push("Maximum: hindi pwedeng mas mababa sa minimum.");
  }
  if (!customizationId) {
    errors.push("Walang payment customization na makikita.");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  try {
    // Merge into the CURRENT config so advanced keys (allowedZipRanges,
    // allowedCities, cityAliases, codMethodName) survive a save from this page.
    const currentResponse = await admin.graphql(CURRENT_CONFIG_QUERY, {
      variables: { id: customizationId },
    });
    const currentResult = (await currentResponse.json()) as {
      data?: {
        paymentCustomization?: { metafield?: { jsonValue?: CodConfig } | null };
      };
    };
    const merged: CodConfig = {
      ...(currentResult.data?.paymentCustomization?.metafield?.jsonValue ?? {}),
    };
    // Blank minimum = "walang minimum" → write an EXPLICIT 0. An absent key
    // falls back to the function's built-in ₱2,500 minimum default (the bug
    // found live on prod, 2026-07-28: deleted key → function hid COD at ₱799).
    merged.minimumAmount = minimumAmount ?? 0;
    if (maximumAmount === null) delete merged.maximumAmount;
    else merged.maximumAmount = maximumAmount;
    // Third copy of the fee, this one for the checkout function: it renames the
    // COD payment method so the "+₱70" the merchant typed into Settings →
    // Payments follows this page. The function reads only this metafield, and
    // Shopify exposes no API for that method's name.
    if (feeAmount === null) delete merged.feeAmount;
    else merged.feeAmount = feeAmount;

    const setResponse = await admin.graphql(SET_CONFIG_MUTATION, {
      variables: {
        metafields: [
          {
            ownerId: customizationId,
            namespace: CONFIG_NAMESPACE,
            key: CONFIG_KEY,
            type: "json",
            value: JSON.stringify(merged),
          },
        ],
      },
    });
    const setResult = (await setResponse.json()) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ message: string }> } };
    };
    for (const err of setResult.data?.metafieldsSet?.userErrors ?? []) {
      errors.push(`Config: ${err.message}`);
    }

    const toggleResponse = await admin.graphql(TOGGLE_MUTATION, {
      variables: { id: customizationId, enabled },
    });
    const toggleResult = (await toggleResponse.json()) as {
      data?: {
        paymentCustomizationUpdate?: {
          userErrors?: Array<{ message: string }>;
        };
      };
    };
    for (const err of toggleResult.data?.paymentCustomizationUpdate
      ?.userErrors ?? []) {
      errors.push(`Enable/disable: ${err.message}`);
    }

    if (feeAmount !== null && variantId && productId) {
      const feeResponse = await admin.graphql(FEE_PRICE_MUTATION, {
        variables: {
          productId,
          variants: [{ id: variantId, price: feeAmount.toFixed(2) }],
        },
      });
      const feeResult = (await feeResponse.json()) as {
        data?: {
          productVariantsBulkUpdate?: {
            userErrors?: Array<{ message: string }>;
          };
        };
      };
      for (const err of feeResult.data?.productVariantsBulkUpdate?.userErrors ??
        []) {
        errors.push(`COD fee: ${err.message}`);
      }

      // Mirror the fee onto shop metafields so the surfaces that CANNOT read the
      // variant price still show the amount that will actually be charged (the
      // COD Fee product is unpublished from the Online Store on purpose). Before
      // this, each surface fell back to its own separate copy of the number, so
      // repricing here left the customer reading the old one while being charged
      // the new one (caught 2026-08-14: fee set to ₱85, Thank You page still
      // said ₱70).
      //
      // Three copies of the same value, because no single namespace is readable
      // everywhere: `$app:cod` for the checkout UI extensions, `custom.cod_fee`
      // for Liquid, and `_cod_fee.commission` for the Releasit block that draws
      // the fee in the order confirmation email (see the constants above).
      //
      // A failure here must not fail the save: the price above is what gets
      // charged and is already committed. The customer would just see a stale
      // display, which is the behaviour we had before.
      const shopResponse = await admin.graphql(SHOP_ID_QUERY);
      const shopResult = (await shopResponse.json()) as {
        data?: { shop?: { id?: string } };
      };
      const shopId = shopResult.data?.shop?.id;

      if (shopId) {
        const mirrorResponse = await admin.graphql(SET_CONFIG_MUTATION, {
          variables: {
            metafields: [
              {
                ownerId: shopId,
                namespace: COD_FEE_METAFIELD_NAMESPACE,
                key: COD_FEE_METAFIELD_KEY,
                type: "number_decimal",
                value: feeAmount.toFixed(2),
              },
              {
                ownerId: shopId,
                namespace: COD_FEE_LIQUID_NAMESPACE,
                key: COD_FEE_LIQUID_KEY,
                type: "number_decimal",
                value: feeAmount.toFixed(2),
              },
              {
                ownerId: shopId,
                namespace: RELEASIT_FEE_NAMESPACE,
                key: RELEASIT_FEE_KEY,
                type: "number_integer",
                value: toReleasitCentavos(feeAmount),
              },
            ],
          },
        });
        const mirrorResult = (await mirrorResponse.json()) as {
          data?: { metafieldsSet?: { userErrors?: Array<{ message: string }> } };
        };
        for (const err of mirrorResult.data?.metafieldsSet?.userErrors ?? []) {
          console.warn(`[cod-settings] fee mirror metafield: ${err.message}`);
        }
      } else {
        console.warn(
          "[cod-settings] no shop id returned; fee mirror metafield not written.",
        );
      }
    }

    return { ok: errors.length === 0, errors };
  } catch (error) {
    // ADR-11: never bubble a raw 5xx through the embedded fetcher.
    console.error("COD settings save failed:", error);
    errors.push("Hindi na-save — nag-error ang Shopify. Subukan ulit.");
    return { ok: false, errors };
  }
};

export default function CodSettingsPage() {
  const { customization, config, feeVariant, feeSku } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [minimum, setMinimum] = useState(
    config.minimumAmount === null || config.minimumAmount === 0
      ? ""
      : String(config.minimumAmount),
  );
  const [maximum, setMaximum] = useState(
    config.maximumAmount === null ? "" : String(config.maximumAmount),
  );
  const [fee, setFee] = useState(feeVariant?.price ?? "");
  const [enabled, setEnabled] = useState(customization?.enabled ?? false);
  const [savedBanner, setSavedBanner] = useState(false);

  const saving = fetcher.state !== "idle";
  const saveErrors = fetcher.data?.ok === false ? fetcher.data.errors : [];

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setSavedBanner(true);
    }
  }, [fetcher.state, fetcher.data]);

  const handleSave = useCallback(() => {
    setSavedBanner(false);
    fetcher.submit(
      {
        customizationId: customization?.id ?? "",
        enabled: String(enabled),
        minimumAmount: minimum,
        maximumAmount: maximum,
        feeAmount: fee,
        variantId: feeVariant?.id ?? "",
        productId: feeVariant?.productId ?? "",
      },
      { method: "post" },
    );
  }, [fetcher, customization, enabled, minimum, maximum, fee, feeVariant]);

  return (
    <Page narrowWidth>
      <TitleBar title="COD Settings" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {savedBanner ? (
              <Banner tone="success" onDismiss={() => setSavedBanner(false)}>
                Na-save na ang COD settings. Agad itong gagana sa checkout.
              </Banner>
            ) : null}
            {saveErrors.length > 0 ? (
              <Banner tone="critical">
                <BlockStack gap="100">
                  {saveErrors.map((error) => (
                    <Text as="p" key={error}>
                      {error}
                    </Text>
                  ))}
                </BlockStack>
              </Banner>
            ) : null}
            {!customization ? (
              <Banner tone="warning">
                Walang nakitang COD payment customization sa store na ito.
                I-activate muna ang cod-eligibility function.
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Cash on Delivery
                  </Text>
                  <Badge tone={enabled ? "success" : "critical"}>
                    {enabled ? "Active" : "Disabled"}
                  </Badge>
                </InlineStack>
                <Checkbox
                  label="I-enable ang COD eligibility rules sa checkout"
                  helpText="Kapag naka-off, hindi itatago ng function ang COD — laging lalabas ang manual payment method."
                  checked={enabled}
                  onChange={setEnabled}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Order amount rules
                </Text>
                <TextField
                  label="Minimum subtotal (₱)"
                  helpText="Itago ang COD kapag mas mababa dito ang subtotal. Iwanang blangko kung walang minimum."
                  value={minimum}
                  onChange={setMinimum}
                  type="number"
                  autoComplete="off"
                  disabled={saving}
                />
                <TextField
                  label="Maximum subtotal (₱)"
                  helpText="Itago ang COD kapag lampas dito ang subtotal. Iwanang blangko kung walang cap."
                  value={maximum}
                  onChange={setMaximum}
                  type="number"
                  autoComplete="off"
                  disabled={saving}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  COD fee
                </Text>
                <TextField
                  label="Fee amount (₱)"
                  helpText='Presyo ng hidden na "COD Fee" product — awtomatikong idinadagdag sa COD orders pagkatapos ng checkout.'
                  value={fee}
                  onChange={setFee}
                  type="number"
                  autoComplete="off"
                  disabled={saving || !feeVariant}
                />
                {!feeVariant ? (
                  <Banner tone="warning">
                    Walang product na may SKU {feeSku} sa store na ito —
                    hindi maidadagdag ang fee hangga&apos;t wala ito.
                  </Banner>
                ) : null}
                <Text as="p" tone="subdued" variant="bodySm">
                  Ang area rules (Metro Manila ZIP masterlist + city fallback)
                  ay naka-built-in sa function; ang minimum/maximum at fee lang
                  ang editable dito.
                </Text>
              </BlockStack>
            </Card>

            <InlineStack align="end">
              <Button
                variant="primary"
                onClick={handleSave}
                loading={saving}
                disabled={!customization}
              >
                Save settings
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

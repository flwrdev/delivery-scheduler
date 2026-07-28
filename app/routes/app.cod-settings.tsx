// COD Settings — merchant-editable knobs for the COD eligibility function +
// the ₱ COD fee, without redeploys. Writes:
//   - the `$app:cod-eligibility` / `function-configuration` metafield on the
//     app's PaymentCustomization (read live by the checkout function),
//   - the COD Fee variant's price (SKU COD-FEE — the amount the orders/create
//     webhook adds to COD orders),
//   - the payment customization's enabled flag.
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

const CONFIG_NAMESPACE = "$app:cod-eligibility";
const CONFIG_KEY = "function-configuration";
const COD_FEE_SKU = "COD-FEE";

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
    productVariants(first: 1, query: "sku:${COD_FEE_SKU}") {
      nodes {
        id
        price
        product {
          id
          title
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

type CodConfig = {
  minimumAmount?: number;
  maximumAmount?: number;
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
      productVariants?: {
        nodes?: Array<{
          id: string;
          price: string;
          product: { id: string; title: string };
        }>;
      };
    };
  };

  const customizations = result.data?.paymentCustomizations?.nodes ?? [];
  const customization =
    customizations.find((node) => node.metafield?.jsonValue) ??
    customizations.find((node) => /cod|cash on delivery/i.test(node.title)) ??
    null;
  const feeVariant = result.data?.productVariants?.nodes?.[0] ?? null;
  const config: CodConfig = customization?.metafield?.jsonValue ?? {};

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
          productId: feeVariant.product.id,
          price: feeVariant.price,
        }
      : null,
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
      paymentCustomizationUpdate?: { userErrors?: Array<{ message: string }> };
    };
  };
  for (const err of toggleResult.data?.paymentCustomizationUpdate?.userErrors ??
    []) {
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
  }

  return { ok: errors.length === 0, errors };
};

export default function CodSettingsPage() {
  const { customization, config, feeVariant } = useLoaderData<typeof loader>();
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
                    Walang product na may SKU {COD_FEE_SKU} sa store na ito —
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

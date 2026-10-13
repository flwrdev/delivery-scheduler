// AdminGraphQLClient over shopify.query, for the shared services that expect
// a fetch-style Response.
export const adminClient = {
  async graphql(query, options) {
    const result = await shopify.query(query, {
      variables: options?.variables,
    });
    return {
      ok: true,
      status: 200,
      json: async () => result,
    };
  },
};

let shopDomainPromise = null;

export function getShopDomain() {
  if (!shopDomainPromise) {
    shopDomainPromise = shopify
      .query(`query ShopDomain { shop { myshopifyDomain } }`)
      .then((result) => result?.data?.shop?.myshopifyDomain ?? "")
      .catch((error) => {
        shopDomainPromise = null;
        throw error;
      });
  }
  return shopDomainPromise;
}

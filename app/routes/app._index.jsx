import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Button,
  Banner,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { useState, useEffect } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

export async function loader({ request }) {
  await authenticate.admin(request);
  return null;
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  const url = formData.get("url");
  const consumerKey = formData.get("consumerKey");
  const consumerSecret = formData.get("consumerSecret");

  if (intent === "fetch_woo") {
    try {
      const cleanUrl = url.replace(/\/$/, "");
      const ApiClass = WooCommerceRestApi.default || WooCommerceRestApi;

      const api = new ApiClass({
        url: cleanUrl,
        consumerKey: consumerKey,
        consumerSecret: consumerSecret,
        version: "wc/v3",
        queryStringAuth: true,
      });

      const response = await api.get("products", { per_page: 50 });
      const wooProducts = response.data;

      if (!Array.isArray(wooProducts)) {
        return {
          success: false,
          error: "Invalid response format from WooCommerce. Expected array.",
        };
      }

      return { success: true, products: wooProducts, intent: "fetch_woo" };
    } catch (err) {
      console.error("Fetch error:", err);
      return { success: false, error: `Detailed Error: ${err.message}` };
    }
  }

  if (intent === "migrate_product") {
    try {
      const product = JSON.parse(formData.get("product"));

      let actionTaken = "none";
      const existingProductResponse = await admin.graphql(
        `
        query getProduct($query: String!) {
          products(first: 5, query: $query) {
            edges {
              node {
                id
                title
              }
            }
          }
        }
      `,
        {
          variables: {
            query: `title:${product.name}`,
          },
        },
      );

      const existingProductJson = await existingProductResponse.json();
      const existingEdges = existingProductJson.data.products.edges;
      const existingProduct = existingEdges.find(
        (edge) => edge.node.title === product.name,
      )?.node;

      if (existingProduct) {
        await admin.graphql(
          `
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product {
              id
            }
          }
        }
      `,
          {
            variables: {
              input: {
                id: existingProduct.id,
                title: product.name,
                descriptionHtml: product.description,
                status: product.status === "publish" ? "ACTIVE" : "DRAFT",
              },
            },
          },
        );
        actionTaken = "updated";
      } else {
        await admin.graphql(
          `
        mutation productCreate($input: ProductInput!) {
          productCreate(input: $input) {
            product {
              id
            }
          }
        }
      `,
          {
            variables: {
              input: {
                title: product.name,
                descriptionHtml: product.description,
                status: product.status === "publish" ? "ACTIVE" : "DRAFT",
              },
            },
          },
        );
        actionTaken = "created";
      }

      return { success: true, intent: "migrate_product", actionTaken };
    } catch (err) {
      console.error("Migration item error:", err);
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: "Unknown intent" };
}

export default function Index() {
  const fetcher = useFetcher();
  const migrateFetcher = useFetcher();

  const [url, setUrl] = useState("http://aurelia.local/");
  const [consumerKey, setConsumerKey] = useState(
    "ck_52b365c5ece4b8ac05bba32bf9d17c1f6ef14d38",
  );
  const [consumerSecret, setConsumerSecret] = useState(
    "cs_2796315b6fc10f905ef4f36170b9b727ee42142e",
  );

  const [productsQueue, setProductsQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isMigrating, setIsMigrating] = useState(false);
  const [stats, setStats] = useState({ created: 0, updated: 0, failed: 0 });
  const [generalError, setGeneralError] = useState(null);

  const handleStart = () => {
    setGeneralError(null);
    setStats({ created: 0, updated: 0, failed: 0 });
    setProductsQueue([]);
    setCurrentIndex(0);
    setIsMigrating(true);

    fetcher.submit(
      { intent: "fetch_woo", url, consumerKey, consumerSecret },
      { method: "POST" },
    );
  };

  useEffect(() => {
    if (fetcher.data && fetcher.data.intent === "fetch_woo") {
      if (fetcher.data.success) {
        setProductsQueue(fetcher.data.products);
      } else {
        setGeneralError(fetcher.data.error);
        setIsMigrating(false);
      }
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (!isMigrating || productsQueue.length === 0) return;

    if (currentIndex >= productsQueue.length) {
      setIsMigrating(false);
      return;
    }

    if (migrateFetcher.state === "idle" && !migrateFetcher.data) {
      triggerMigration(productsQueue[0]);
    } else if (migrateFetcher.state === "idle" && migrateFetcher.data) {
      // Note: useFetcher holds data from last request. check if we processed it.
    }
  }, [isMigrating, productsQueue, currentIndex]); // eslint-disable-line

  useEffect(() => {
    if (migrateFetcher.state === "idle" && migrateFetcher.data && isMigrating) {
      const data = migrateFetcher.data;

      if (data.intent === "migrate_product") {
        if (data.success) {
          if (data.actionTaken === "created")
            setStats((s) => ({ ...s, created: s.created + 1 }));
          if (data.actionTaken === "updated")
            setStats((s) => ({ ...s, updated: s.updated + 1 }));
        } else {
          setStats((s) => ({ ...s, failed: s.failed + 1 }));
        }

        const nextIndex = currentIndex + 1;
        setCurrentIndex(nextIndex);

        if (nextIndex < productsQueue.length) {
          triggerMigration(productsQueue[nextIndex]);
        } else {
          setIsMigrating(false);
        }
      }
    }
  }, [migrateFetcher.state, migrateFetcher.data, isMigrating, productsQueue]); // eslint-disable-line

  const triggerMigration = (product) => {
    migrateFetcher.submit(
      {
        intent: "migrate_product",
        product: JSON.stringify(product),
        url,
      },
      { method: "POST" },
    );
  };

  const total = productsQueue.length;
  const progress = total > 0 ? (currentIndex / total) * 100 : 0;
  const isFetchingList =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const isProcessing = isMigrating && productsQueue.length > 0;

  return (
    <Page title="Woo Migration">
      <Layout>
        <Layout.Section>
          <Card>
            <FormLayout>
              <TextField
                label="Store URL"
                value={url}
                onChange={setUrl}
                disabled={isProcessing}
              />
              <TextField
                label="Consumer Key"
                value={consumerKey}
                onChange={setConsumerKey}
                disabled={isProcessing}
              />
              <TextField
                label="Consumer Secret"
                value={consumerSecret}
                onChange={setConsumerSecret}
                disabled={isProcessing}
              />

              <Button
                variant="primary"
                loading={isFetchingList}
                disabled={isProcessing}
                onClick={handleStart}
              >
                {isProcessing ? "Processing..." : "Start Migration"}
              </Button>
            </FormLayout>
          </Card>
          {generalError && (
            <Banner tone="critical" title="Error">
              <p>{generalError}</p>
            </Banner>
          )}
          {(isProcessing || (total > 0 && !isProcessing)) && (
            <div
              style={{
                marginTop: "10px",
                backgroundColor: "#f5f5f5",
                padding: "20px",
                borderRadius: "10px",
              }}
            >
              <Text variant="headingMd" as="h2">
                {isProcessing ? "Migrating Products..." : "Migration Complete"}
              </Text>
              <div
                style={{
                  marginTop: "10px",
                  border: "2px solid #047b5d",
                  borderRadius: "6px",
                }}
              >
                <ProgressBar size="small" progress={progress} tone="success" />
              </div>
              <div style={{ marginTop: "10px" }}>
                <Text as="p">
                  Processed: {currentIndex} / {total}
                </Text>
                <Text as="p" tone="subdued">
                  Created: {stats.created} | Updated: {stats.updated} | Failed:{" "}
                  {stats.failed}
                </Text>
              </div>
            </div>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
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

      const page = parseInt(formData.get("page") || "1", 10);
      
      console.log(`Fetching page ${page}...`);
      const response = await api.get("products", {
        per_page: 50,
        page: page,
      });

      const products = response.data;

      if (!Array.isArray(products)) {
        return {
          success: false,
          error: "Invalid response format from WooCommerce. Expected array.",
        };
      }

      let totalPages = 1;
      let totalProducts = products.length;

      if (response.headers["x-wp-totalpages"]) {
        totalPages = parseInt(response.headers["x-wp-totalpages"], 10);
      }
      if (response.headers["x-wp-total"]) {
        totalProducts = parseInt(response.headers["x-wp-total"], 10);
      }

      return { 
        success: true, 
        products: products, 
        intent: "fetch_woo",
        page: page, 
        totalPages: totalPages,
        totalProducts: totalProducts
      };
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
    "ck_cc798a8e1f1a758ed5282e46aa9b1d017d939c49",
  );
  const [consumerSecret, setConsumerSecret] = useState(
    "cs_b9d97bc5586c05562d84940f709a93b6d219b262",
  );

  const [productsQueue, setProductsQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isMigrating, setIsMigrating] = useState(false);
  const [stats, setStats] = useState({ created: 0, updated: 0, failed: 0 });
  const [generalError, setGeneralError] = useState(null);
  
  // Pagination State
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);

  const handleStart = () => {
    setGeneralError(null);
    setStats({ created: 0, updated: 0, failed: 0 });
    setProductsQueue([]);
    setCurrentIndex(0);
    setCurrentPage(0);
    setTotalPages(1);
    setTotalProducts(0);
    setIsMigrating(true);

    fetcher.submit(
      { intent: "fetch_woo", url, consumerKey, consumerSecret, page: "1" },
      { method: "POST" },
    );
  };

  useEffect(() => {
    if (fetcher.data && fetcher.data.intent === "fetch_woo") {
      if (fetcher.data.success) {
        setProductsQueue(fetcher.data.products);
        setCurrentIndex(0); // Reset for new batch
        setCurrentPage(fetcher.data.page);
        setTotalPages(fetcher.data.totalPages);
        setTotalProducts(fetcher.data.totalProducts);
      } else {
        setGeneralError(fetcher.data.error);
        setIsMigrating(false);
      }
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (!isMigrating || productsQueue.length === 0) return;

    if (currentIndex >= productsQueue.length) {
       // Wait for next fetching triggers
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
          // Batch processed. Check if more pages exist.
          if (currentPage < totalPages) {
             const nextPage = currentPage + 1;
             console.log(`Fetching next page: ${nextPage}`);
             fetcher.submit(
               { intent: "fetch_woo", url, consumerKey, consumerSecret, page: nextPage.toString() },
               { method: "POST" }
             );
          } else {
             setIsMigrating(false);
          }
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

  const overallProgress = totalProducts > 0 
    ? ((stats.created + stats.updated + stats.failed) / totalProducts) * 100 
    : 0;

  const isFetchingList =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const isProcessing = isMigrating; // Generalized check

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
          {(isProcessing || (stats.created + stats.updated + stats.failed > 0)) && (
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
                <ProgressBar size="small" progress={overallProgress} tone="success" />
              </div>
              <div style={{ marginTop: "10px" }}>
                <Text as="p">
                  Page: {currentPage} / {totalPages}
                </Text>
                <Text as="p" tone="subdued">
                  Created: {stats.created} | Updated: {stats.updated} | Failed:{" "}
                  {stats.failed} | Total: {totalProducts}
                </Text>
              </div>
            </div>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}

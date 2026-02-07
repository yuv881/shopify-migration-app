import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Button,
  Banner,
} from "@shopify/polaris";
import { useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api";

/* ---------------- LOADER ---------------- */
export async function loader({ request }) {
  await authenticate.admin(request);
  return null;
}

/* ---------------- ACTION ---------------- */
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const url = formData.get("url");
  const consumerKey = formData.get("consumerKey");
  const consumerSecret = formData.get("consumerSecret");

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
      console.error("Invalid response format:", wooProducts);
      return {
        success: false,
        error: "Invalid response format from WooCommerce. Expected array.",
      };
    }

    for (const product of wooProducts) {
      await admin.graphql(
        `
        mutation productCreate($input: ProductInput!) {
          productCreate(input: $input) {
            product{
              id
              title
              descriptionHtml
              status       
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
    }

    return { success: true, count: wooProducts.length };
  } catch (err) {
    console.error("Migration error:", err);
    return { success: false, error: `Detailed Error: ${err.message}` };
  }
}

export default function Index() {
  const fetcher = useFetcher();

  const [url, setUrl] = useState("http://aurelia.local/");
  const [consumerKey, setConsumerKey] = useState(
    "ck_52b365c5ece4b8ac05bba32bf9d17c1f6ef14d38",
  );
  const [consumerSecret, setConsumerSecret] = useState(
    "cs_2796315b6fc10f905ef4f36170b9b727ee42142e",
  );

  const loading = fetcher.state === "submitting";
  const error = fetcher.data?.error;
  const success = fetcher.data?.success;
  const count = fetcher.data?.count;

  const handleMigrate = () => {
    fetcher.submit({ url, consumerKey, consumerSecret }, { method: "POST" });
  };

  return (
    <Page title="Woo Migration">
      <Layout>
        <Layout.Section>
          {error && (
            <Banner tone="critical" title="Migration Failed">
              <p>{error}</p>
            </Banner>
          )}
          {success && (
            <Banner tone="success" title="Migration Successful">
              <p>Successfully migrated {count} products.</p>
            </Banner>
          )}
          <Card>
            <FormLayout>
              <TextField label="Store URL" value={url} onChange={setUrl} />

              <TextField
                label="Consumer Key"
                value={consumerKey}
                onChange={setConsumerKey}
              />

              <TextField
                label="Consumer Secret"
                value={consumerSecret}
                onChange={setConsumerSecret}
              />

              <Button
                variant="primary"
                loading={loading}
                onClick={handleMigrate}
              >
                Start Migration
              </Button>
            </FormLayout>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// Vercel serverless function — bridge between the app and your Notion database.
// GET  /api/recipes        → list all recipes
// POST /api/recipes        → create a recipe   { recipe: {...} }
// PUT  /api/recipes        → update a recipe   { id, recipe: {...} }
// DELETE /api/recipes?id=  → delete (archive) a recipe

const NOTION_VERSION = "2022-06-28";

async function notion(path, opts = {}) {
  const r = await fetch("https://api.notion.com/v1" + path, {
    ...opts,
    headers: {
      "Authorization": "Bearer " + process.env.NOTION_TOKEN,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!r.ok) {
    const msg = (data && data.message) || text || ("HTTP " + r.status);
    throw new Error("Notion " + r.status + ": " + msg);
  }
  return data;
}

// Notion property helpers ----------------------------------------------------
const richText = (s) => s ? [{ type: "text", text: { content: String(s).slice(0, 1900) } }] : [];
const titleProp = (s) => ({ title: richText(s) });
const textProp = (s) => ({ rich_text: richText(s) });
const numProp = (n) => ({ number: (n === null || n === undefined || n === "") ? null : Number(n) });
const checkProp = (b) => ({ checkbox: !!b });
const urlProp = (s) => ({ url: s || null });
const selProp = (s) => ({ select: s ? { name: s } : null });
const mselProp = (arr) => ({ multi_select: (arr || []).filter(Boolean).map(name => ({ name })) });

// Recipe → Notion properties (only set what's defined to avoid wiping values)
function recipeToProps(r) {
  const p = {};
  if (r.title !== undefined) p["Name"] = titleProp(r.title);
  if (r.description !== undefined) p["Description"] = textProp(r.description);
  if (r.ingredients !== undefined) p["Ingredients"] = textProp(JSON.stringify(r.ingredients));
  if (r.steps !== undefined) p["Steps"] = textProp(JSON.stringify(r.steps));
  if (r.notes !== undefined) p["Notes"] = textProp(r.notes);
  if (r.link !== undefined) p["Link"] = urlProp(r.link);
  if (r.cuisine !== undefined) p["Cuisine"] = textProp(r.cuisine);
  if (r.time_minutes !== undefined) p["Time"] = numProp(r.time_minutes);
  if (r.servings !== undefined) p["Servings"] = numProp(r.servings);
  if (r.favorite !== undefined) p["Favorite"] = checkProp(r.favorite);
  if (r.flavor !== undefined) p["Flavor"] = selProp(r.flavor);
  if (r.meal !== undefined) p["Meal"] = mselProp(r.meal);
  if (r.tags !== undefined) p["Tags"] = mselProp(r.tags);
  return p;
}

// Notion page → recipe
function plain(prop) {
  if (!prop) return "";
  if (prop.type === "title") return (prop.title || []).map(t => t.plain_text).join("");
  if (prop.type === "rich_text") return (prop.rich_text || []).map(t => t.plain_text).join("");
  return "";
}
function pageToRecipe(page) {
  const p = page.properties || {};
  const ingStr = plain(p["Ingredients"]);
  const stepStr = plain(p["Steps"]);
  let ingredients = []; try { ingredients = JSON.parse(ingStr); if (!Array.isArray(ingredients)) ingredients = []; } catch {}
  let steps = []; try { steps = JSON.parse(stepStr); if (!Array.isArray(steps)) steps = []; } catch {
    // legacy: someone wrote plain text — split by newline
    steps = stepStr ? stepStr.split(/\r?\n+/).filter(Boolean) : [];
  }
  return {
    id: page.id,
    createdAt: new Date(page.created_time).getTime(),
    title: plain(p["Name"]) || "Untitled",
    description: plain(p["Description"]),
    ingredients,
    steps,
    notes: plain(p["Notes"]),
    link: (p["Link"] && p["Link"].url) || "",
    cuisine: plain(p["Cuisine"]),
    time_minutes: (p["Time"] && p["Time"].number) || null,
    servings: (p["Servings"] && p["Servings"].number) || 1,
    favorite: !!(p["Favorite"] && p["Favorite"].checkbox),
    flavor: (p["Flavor"] && p["Flavor"].select && p["Flavor"].select.name) || "savory",
    meal: ((p["Meal"] && p["Meal"].multi_select) || []).map(o => o.name),
    tags: ((p["Tags"] && p["Tags"].multi_select) || []).map(o => o.name),
    hasPhoto: false,
  };
}

async function listAll(dbId) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100, sorts: [{ timestamp: "created_time", direction: "descending" }] };
    if (cursor) body.start_cursor = cursor;
    const data = await notion("/databases/" + dbId + "/query", { method: "POST", body: JSON.stringify(body) });
    out.push(...(data.results || []).filter(r => !r.archived).map(pageToRecipe));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
      return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DATABASE_ID env vars." });
    }
    const dbId = process.env.NOTION_DATABASE_ID;

    if (req.method === "GET") {
      const recipes = await listAll(dbId);
      return res.status(200).json({ recipes });
    }

    // parse body for write methods
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    if (req.method === "POST") {
      const recipe = body.recipe || {};
      const created = await notion("/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: dbId },
          properties: recipeToProps(recipe),
        }),
      });
      return res.status(200).json({ recipe: pageToRecipe(created) });
    }

    if (req.method === "PUT") {
      const id = body.id;
      const recipe = body.recipe || {};
      if (!id) return res.status(400).json({ error: "Missing id" });
      const updated = await notion("/pages/" + id, {
        method: "PATCH",
        body: JSON.stringify({ properties: recipeToProps(recipe) }),
      });
      return res.status(200).json({ recipe: pageToRecipe(updated) });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing id" });
      await notion("/pages/" + id, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("api/recipes error:", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}

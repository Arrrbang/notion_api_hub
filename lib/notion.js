import { Client } from "@notionhq/client";

export const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

export async function queryDatabase({
  database_id,
  filter,
  sorts,
  page_size,
  start_cursor
}) {
  const body = {};
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  if (page_size) body.page_size = Math.min(Number(page_size) || 100, 100);
  if (start_cursor) body.start_cursor = start_cursor;

  return notion.databases.query({
    database_id,
    ...body
  });
}

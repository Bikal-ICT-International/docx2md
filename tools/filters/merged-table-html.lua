-- Convert tables with merged cells (rowspan/colspan) into raw HTML blocks.
-- This preserves merged-cell layout in Markdown output.

local function span_value(val)
  if val == nil then
    return nil
  end
  if type(val) == "number" then
    return val
  end
  if type(val) == "string" then
    local n = tonumber(val)
    return n
  end
  return nil
end

local function cell_span_gt_one(cell)
  if cell == nil then
    return false
  end

  local row_span = span_value(cell.row_span or cell.rowSpan or cell.rowspan)
  local col_span = span_value(cell.col_span or cell.colSpan or cell.colspan)

  if cell.attr and cell.attr.attributes then
    row_span = row_span or span_value(cell.attr.attributes.rowspan)
    col_span = col_span or span_value(cell.attr.attributes.colspan)
  end

  if cell.attributes then
    row_span = row_span or span_value(cell.attributes.rowspan)
    col_span = col_span or span_value(cell.attributes.colspan)
  end

  if row_span ~= nil and row_span ~= 1 then
    return true
  end

  if col_span ~= nil and col_span ~= 1 then
    return true
  end

  return false
end

local function table_has_merged_cells(tbl)
  if tbl == nil then
    return false
  end

  -- Head
  if tbl.head and tbl.head.rows then
    for _, row in ipairs(tbl.head.rows) do
      for _, cell in ipairs(row.cells or {}) do
        if cell_span_gt_one(cell) then
          return true
        end
      end
    end
  end

  -- Bodies
  if tbl.bodies then
    for _, body in ipairs(tbl.bodies) do
      for _, row in ipairs(body.rows or {}) do
        for _, cell in ipairs(row.cells or {}) do
          if cell_span_gt_one(cell) then
            return true
          end
        end
      end
    end
  end

  -- Foot
  if tbl.foot and tbl.foot.rows then
    for _, row in ipairs(tbl.foot.rows) do
      for _, cell in ipairs(row.cells or {}) do
        if cell_span_gt_one(cell) then
          return true
        end
      end
    end
  end

  return false
end

local function count_merged_cells(tbl)
  local merged = 0
  local total = 0

  local function scan_rows(rows)
    for _, row in ipairs(rows or {}) do
      for _, cell in ipairs(row.cells or {}) do
        total = total + 1
        if cell_span_gt_one(cell) then
          merged = merged + 1
        end
      end
    end
  end

  if tbl.head and tbl.head.rows then
    scan_rows(tbl.head.rows)
  end

  if tbl.bodies then
    for _, body in ipairs(tbl.bodies) do
      scan_rows(body.rows or {})
    end
  end

  if tbl.foot and tbl.foot.rows then
    scan_rows(tbl.foot.rows)
  end

  return merged, total
end

function Table(el)
  local force_html = os.getenv("DOCX2MD_FORCE_HTML_TABLES") == "1"
  if force_html or table_has_merged_cells(el) then
    if os.getenv("DOCX2MD_DEBUG_TABLES") == "1" then
      local merged, total = count_merged_cells(el)
      io.stderr:write(string.format("[docx2md] table to html: merged_cells=%d total_cells=%d force=%s\n", merged, total, tostring(force_html)))
    end
    local doc = pandoc.Pandoc({ el })
    local html = pandoc.write(doc, "html")
    return pandoc.RawBlock("html", html)
  end
end

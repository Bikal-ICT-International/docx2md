-- Convert images and tables to raw HTML in Markdown output.
-- This preserves formatting, alignment, and captions for HTML-capable renderers.

local function attr_to_html(attr, extra_attrs)
  local parts = {}

  if attr and attr.attributes then
    for k, v in pairs(attr.attributes) do
      if v ~= nil and v ~= "" then
        table.insert(parts, string.format('%s="%s"', k, v))
      end
    end
  end

  if extra_attrs then
    for k, v in pairs(extra_attrs) do
      if v ~= nil and v ~= "" then
        local already = false
        if attr and attr.attributes and attr.attributes[k] ~= nil then
          already = true
        end
        if not already then
          table.insert(parts, string.format('%s="%s"', k, v))
        end
      end
    end
  end

  if #parts == 0 then
    return ""
  end

  return " " .. table.concat(parts, " ")
end

local function safe_stringify(inlines)
  if pandoc and pandoc.utils and pandoc.utils.stringify then
    return pandoc.utils.stringify(inlines)
  end
  return ""
end

function Table(el)
  local doc = pandoc.Pandoc({ el })
  local html = pandoc.write(doc, "html")
  return pandoc.RawBlock("html", html)
end

function Image(el)
  local src = el.src or (el.target and el.target[1]) or ""
  local title = el.title or (el.target and el.target[2]) or ""
  local alt = safe_stringify(el.caption or el.alt or el)

  local attrs = attr_to_html(el.attr, { alt = alt, title = title })
  local html = string.format('<img src="%s"%s />', src, attrs)
  return pandoc.RawInline("html", html)
end

function Figure(el)
  local doc = pandoc.Pandoc({ el })
  local html = pandoc.write(doc, "html")
  return pandoc.RawBlock("html", html)
end

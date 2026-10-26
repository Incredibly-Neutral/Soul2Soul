-- ============================================================================
-- s2s.format — PURE result formatting.
--
-- Plain Lua tables in, strings/tables out. No `vim.*`, no io, no os.time.
-- Every function is total: nil, `{}`, or garbage in → something sane out,
-- never an error.
--
-- The result shapes are the binary's machine contract (SPEC-author-cli,
-- "Binary API reference"). Known fields are rendered in a fixed order; any
-- *additional* top-level scalar is appended by `extras()` (the open-shape
-- rule); unknown nested tables are dropped silently.
-- ============================================================================

local M = {}

-- Known top-level fields per action, in display order. `render` is expanded
-- into its sub-keys by `known_pairs`.
local KNOWN = {
  upload = { 'note', 'publication', 'subdomain', 'objectId', 'kuboCid', 'frontmatterWritten' },
  propose = { 'note', 'publication', 'subdomain', 'objectId', 'kuboCid', 'txHash' },
  preview = { 'note', 'publication', 'subdomain', 'objectId', 'kuboCid', 'render' },
  publish = { 'note', 'publication', 'subdomain', 'objectId', 'kuboCid', 'txHash', 'render' },
  revoke = { 'note', 'publication', 'subdomain', 'objectId', 'txHash', 'render' },
  new = {
    'name',
    'safeAddress',
    'configCid',
    'owners',
    'authors',
    'devRepository',
    'branch',
    'feed',
  },
}

-- `render` sub-keys, in display order.
local RENDER_KEYS = { 'cid', 'path', 'previewUrl', 'prodUrl' }

-- Action-less result shapes: the `config` group and the global documents carry
-- no `action` field, so they are detected by shape instead.
KNOWN['config.list'] = { 'config' }
KNOWN['config.path'] = { 'path', 'env' }
KNOWN['config.get'] = {} -- summary carries `key = value`; no duplicated rows
KNOWN['version'] = {} -- summary carries name + version
KNOWN['help'] = { 'help' }

local UNSET = '(unset)'

-- Fields that a shape folds into its summary line, so they must not reappear as
-- pass-through extras.
local FOLDED = {
  ['config.get'] = { key = true, value = true },
  ['config.list'] = { config = true },
  ['config.path'] = { path = true, env = true },
  ['version'] = { name = true, version = true },
  ['help'] = { help = true },
}

-- Envelope/metadata keys that are never "extras" (they are either rendered
-- elsewhere or are transport bookkeeping).
local RESERVED = { ok = true, action = true, error = true }

local VERBS = {
  upload = 'uploaded',
  propose = 'proposed',
  preview = 'previewed',
  publish = 'published',
  revoke = 'revoked',
}

-- ---------------------------------------------------------------------------
-- Scalars
-- ---------------------------------------------------------------------------

-- Render one scalar as display text. nil means "skip this field".
-- Userdata is dropped: JSON null decodes to vim.NIL in Neovim, and we must
-- stay total without referencing `vim`.
local function scalar(v)
  local t = type(v)
  if t == 'string' then
    if v == '' then
      return nil
    end
    return v
  elseif t == 'number' then
    return tostring(v)
  elseif t == 'boolean' then
    return v and 'yes' or 'no'
  end
  return nil
end

-- Lists (owners/authors) are known fields; join their scalar items.
local function list(v)
  if type(v) ~= 'table' then
    return nil
  end
  local parts = {}
  for _, item in ipairs(v) do
    local s = scalar(item)
    if s then
      parts[#parts + 1] = s
    end
  end
  if #parts == 0 then
    return nil
  end
  return table.concat(parts, ', ')
end

local function action_key(result)
  if type(result) ~= 'table' then
    return nil
  end
  local a = result.action
  if type(a) == 'string' and a ~= '' then
    -- Tolerate `publication.new` / `publication new` spellings.
    return (a:gsub('^publication[%s%.]+', ''))
  end
  -- Shape fallback: config results and global documents have no `action`.
  if type(result.config) == 'table' then
    return 'config.list'
  end
  if type(result.path) == 'string' and type(result.env) == 'table' then
    return 'config.path'
  end
  if type(result.key) == 'string' then
    return 'config.get'
  end
  if type(result.help) == 'string' then
    return 'help'
  end
  if type(result.version) == 'string' then
    return 'version'
  end
  return nil
end

-- A decoded JSON null is userdata (vim.NIL) in Neovim; treat it as unset.
local function is_null(v)
  return v == nil or type(v) == 'userdata'
end

-- Sorted `key : value` pairs from a flat record, with an optional prefix.
local function record_pairs(record, prefix)
  local out = {}
  if type(record) ~= 'table' then
    return out
  end
  local keys = {}
  for key, value in pairs(record) do
    if type(key) == 'string' and type(value) ~= 'table' then
      keys[#keys + 1] = key
    end
  end
  table.sort(keys)
  for _, key in ipairs(keys) do
    local v
    if is_null(record[key]) then
      v = UNSET
    else
      v = scalar(record[key])
    end
    if v then
      out[#out + 1] = { (prefix or '') .. key, v }
    end
  end
  return out
end

-- ---------------------------------------------------------------------------
-- Pair builders + alignment
-- ---------------------------------------------------------------------------

local function align(pairs)
  local width = 0
  for _, p in ipairs(pairs) do
    if #p[1] > width then
      width = #p[1]
    end
  end
  local out = {}
  for i, p in ipairs(pairs) do
    out[i] = string.format('%-' .. width .. 's : %s', p[1], p[2])
  end
  return out
end

local function known_pairs(result)
  local out = {}
  if type(result) ~= 'table' then
    return out
  end
  local spec = KNOWN[action_key(result) or '']
  if not spec then
    return out
  end
  for _, key in ipairs(spec) do
    if key == 'render' then
      local r = result.render
      if type(r) == 'table' then
        for _, sub in ipairs(RENDER_KEYS) do
          local v = scalar(r[sub])
          if v then
            out[#out + 1] = { 'render.' .. sub, v }
          end
        end
      end
    elseif key == 'config' or key == 'env' then
      local prefix = key == 'env' and 'env.' or nil
      for _, p in ipairs(record_pairs(result[key], prefix)) do
        out[#out + 1] = p
      end
    elseif key == 'value' and is_null(result.value) then
      out[#out + 1] = { 'value', UNSET }
    elseif key == 'help' then
      local first = scalar(result.help)
      if first then
        out[#out + 1] = { 'help', (first:match('^[^\r\n]+') or first) }
      end
    else
      local v
      if key == 'owners' or key == 'authors' then
        v = list(result[key])
      else
        v = scalar(result[key])
      end
      if v then
        out[#out + 1] = { key, v }
      end
    end
  end
  return out
end

local function error_pairs(result)
  if type(result) ~= 'table' then
    return {}
  end
  local e = scalar(result.error)
  if not e then
    return {}
  end
  return { { 'error', e } }
end

-- Unknown top-level scalars, sorted by key. Unknown nested tables/arrays are
-- dropped: they are decoration we cannot interpret, and must never be fatal.
local function extras_pairs(result)
  local out = {}
  if type(result) ~= 'table' then
    return out
  end
  local known = {}
  local folded = FOLDED[action_key(result) or ''] or {}
  local spec = KNOWN[action_key(result) or '']
  if spec then
    for _, key in ipairs(spec) do
      known[key] = true
    end
  end
  local keys = {}
  for key, value in pairs(result) do
    if
      type(key) == 'string'
      and not folded[key]
      and not known[key]
      and not RESERVED[key]
      and scalar(value) ~= nil
    then
      keys[#keys + 1] = key
    end
  end
  table.sort(keys)
  for _, key in ipairs(keys) do
    out[#out + 1] = { key, scalar(result[key]) }
  end
  return out
end

-- ---------------------------------------------------------------------------
-- Public API
-- ---------------------------------------------------------------------------

--- Map a process exit code to a UI class.
--- 0 → 'ok', 1 → 'error', 2 → 'usage', anything else (including nil) → 'crash'.
function M.exit_kind(code)
  if code == 0 then
    return 'ok'
  elseif code == 1 then
    return 'error'
  elseif code == 2 then
    return 'usage'
  end
  return 'crash'
end

--- A result is a failure when the exit code is non-zero or the envelope says so.
function M.is_failure(result, code)
  if type(code) == 'number' and code ~= 0 then
    return true
  end
  if type(result) ~= 'table' then
    return false
  end
  if result.ok == false then
    return true
  end
  if type(result.error) == 'string' and result.error ~= '' then
    return true
  end
  return false
end

local function basename(path)
  if type(path) ~= 'string' or path == '' then
    return nil
  end
  return path:match('([^/\\]+)$') or path
end

--- One short line: what happened + note basename + the identifying field.
--- nil for failures and for results with no action.
function M.summary(result)
  if type(result) ~= 'table' or M.is_failure(result) then
    return nil
  end
  local key = action_key(result)
  if not key then
    return nil
  end

  if key == 'new' then
    local name = scalar(result.name)
    if not name then
      return nil
    end
    local parts = { 'created ' .. name }
    local safe = scalar(result.safeAddress)
    if safe then
      parts[#parts + 1] = safe
    end
    return table.concat(parts, ' · ')
  end

  if key == 'config.list' then
    local total, unset = 0, 0
    for _, p in ipairs(record_pairs(result.config)) do
      total = total + 1
      if p[2] == UNSET then
        unset = unset + 1
      end
    end
    if total == 0 then
      return 'no config values'
    end
    local line = string.format('%d config keys', total)
    if unset > 0 then
      line = line .. string.format(' · %d unset', unset)
    end
    return line
  end

  if key == 'config.path' then
    local path = scalar(result.path)
    return path and ('config path ' .. path) or nil
  end

  if key == 'config.get' then
    local name = scalar(result.key)
    if not name then
      return nil
    end
    local value
    if is_null(result.value) then
      value = UNSET
    else
      value = scalar(result.value) or UNSET
    end
    return string.format('%s = %s', name, value)
  end

  if key == 'version' then
    local v = scalar(result.version)
    local n = scalar(result.name) or 's2s'
    return v and (n .. ' ' .. v) or nil
  end

  if key == 'help' then
    local text = scalar(result.help)
    if not text then
      return nil
    end
    return text:match('^[^\r\n]+')
  end

  local parts = { (VERBS[key] or key) }
  local base = basename(result.note)
  if base then
    parts[1] = parts[1] .. ' ' .. base
  end

  local ident
  if key == 'propose' or key == 'publish' or key == 'revoke' then
    ident = scalar(result.txHash)
    if ident then
      ident = 'tx ' .. ident
    end
  elseif key == 'upload' or key == 'preview' then
    ident = scalar(result.kuboCid)
  else
    ident = scalar(result.objectId)
  end
  if ident then
    parts[#parts + 1] = ident
  end

  return table.concat(parts, ' · ')
end

--- Known fields only, `key : value`, keys column-aligned. An envelope `error`
--- line comes first when the result carries one.
function M.lines(result)
  local pairs_ = error_pairs(result)
  for _, p in ipairs(known_pairs(result)) do
    pairs_[#pairs_ + 1] = p
  end
  return align(pairs_)
end

--- Unknown top-level scalars (open-shape rule), sorted, `key : value`.
function M.extras(result)
  return align(extras_pairs(result))
end

--- Everything: summary line (if any), then known fields, then extras.
function M.report(result)
  local out = {}
  local summary = M.summary(result)
  if summary then
    out[#out + 1] = summary
  end
  local pairs_ = error_pairs(result)
  for _, p in ipairs(known_pairs(result)) do
    pairs_[#pairs_ + 1] = p
  end
  for _, p in ipairs(extras_pairs(result)) do
    pairs_[#pairs_ + 1] = p
  end
  for _, line in ipairs(align(pairs_)) do
    out[#out + 1] = line
  end
  return out
end

--- The envelope error verbatim (it is written for humans), else a fallback
--- that names the action.
function M.error_message(result)
  if type(result) == 'table' then
    local e = scalar(result.error)
    if e then
      return e
    end
    local a = scalar(result.action)
    if a then
      return 's2s ' .. a .. ' failed (no error message returned)'
    end
  end
  return 's2s failed (no error message returned)'
end

--- The openable target, from `render` only. Never synthesizes a URL.
function M.open_target(result)
  local target = {}
  if type(result) ~= 'table' or type(result.render) ~= 'table' then
    return target
  end
  local r = result.render
  -- publish opens the live site; everything else prefers the preview render.
  local order = action_key(result) == 'publish' and { 'prodUrl', 'previewUrl' }
    or { 'previewUrl', 'prodUrl' }
  local url
  for _, key in ipairs(order) do
    url = url or scalar(r[key])
  end
  if url then
    target.url = url
  end
  local path = scalar(r.path)
  if path then
    target.path = path
  end
  return target
end

return M

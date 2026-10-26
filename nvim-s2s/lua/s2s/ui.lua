-- s2s/ui.lua — every user-visible notification and float lives here.
--
-- No Lua traceback ever escapes: the happy path is wrapped and a failure to
-- format degrades to a plain message.

local M = {}

local api = vim.api
local levels = vim.log.levels

local format_mod = nil

local function fmt()
  if format_mod then
    return format_mod
  end
  local ok, mod = pcall(require, 's2s.format')
  if ok and type(mod) == 'table' then
    format_mod = mod
  end
  return format_mod
end

local function call(name, ...)
  local mod = fmt()
  if not mod then
    return nil
  end
  local fn = mod[name]
  if type(fn) ~= 'function' then
    return nil
  end
  local ok, res = pcall(fn, ...)
  if not ok then
    return nil
  end
  return res
end

local function first_line(text)
  if type(text) ~= 'string' then
    return nil
  end
  for line in text:gmatch('[^\r\n]+') do
    if not line:match('^%s*$') then
      return line
    end
  end
  return nil
end

local function clip(msg)
  if #msg > 600 then
    return msg:sub(1, 597) .. '...'
  end
  return msg
end

local function id_for(buf, action)
  return string.format('s2s:%d:%s', buf or 0, tostring(action))
end

-- Internal notify shim: one place that talks to vim.notify.
local function notify(msg, level, opts)
  pcall(vim.notify, clip(msg), level, opts)
end

local BUSY = {
  upload = 'uploading',
  propose = 'proposing',
  preview = 'previewing',
  publish = 'publishing',
  revoke = 'revoking',
  ['new'] = 'creating publication',
}

--- One notify, replaceable per (buffer, action).
---@param buf integer|nil
---@param action string
function M.busy(buf, action)
  local verb = BUSY[action] or (tostring(action) .. ' in progress')
  notify(string.format('s2s: %s…', verb), levels.INFO, {
    id = id_for(buf, action),
    replace = true,
    title = 's2s',
  })
end

local function basename(path)
  if type(path) ~= 'string' or path == '' then
    return nil
  end
  return vim.fn.fnamemodify(path, ':t')
end

-- What the link line is called, per action.
local LINK_LABEL = { publish = 'live', preview = 'preview' }

--- Success: at most four lines — head, link, summary, then known fields.
---@param buf integer|nil
---@param action string
---@param result table
---@param code integer
---@param ms integer|nil
---@param link { url: string, path?: string }|nil
function M.result(buf, action, result, code, ms, link)
  local head = string.format('s2s %s ok', tostring(action))
  local name = basename(type(result) == 'table' and result.note or nil)
  if name then
    head = head .. ' · ' .. name
  end
  if ms then
    head = head .. ' · ' .. string.format('%dms', ms)
  end

  local lines = { head }
  if type(link) == 'table' and type(link.url) == 'string' then
    lines[#lines + 1] = string.format('%s : %s', LINK_LABEL[action] or 'link', link.url)
  end
  local summary = call('summary', result)
  if type(summary) == 'string' and summary ~= '' then
    lines[#lines + 1] = summary
  end
  local known = call('lines', result)
  if type(known) == 'table' then
    for i = 1, #known do
      if #lines >= 4 then
        break
      end
      if type(known[i]) == 'string' then
        lines[#lines + 1] = known[i]
      end
    end
  end

  notify(table.concat(lines, '\n'), levels.INFO, {
    id = id_for(buf, action),
    replace = true,
    title = 's2s',
  })
end

--- Failures: envelope error at that level, or a one-line diagnostic naming the
--- problem (first stderr line + exit code). Never raw stdout, never a traceback.
---@param buf integer|nil
---@param action string
---@param payload { result?: table, stderr?: string, parse_error?: string, code?: integer, signal?: integer }
function M.failure(buf, action, payload)
  payload = payload or {}
  local code = payload.code
  local result = payload.result
  local has_error = type(result) == 'table' and result.error ~= nil

  local msg
  if has_error then
    local text = call('error_message', result)
    if type(text) ~= 'string' or text == '' then
      text = tostring(result.error)
    end
    msg = string.format('s2s %s: %s', tostring(action), text)
  elseif payload.parse_error then
    msg = string.format('s2s %s: %s (exit %s)', tostring(action), payload.parse_error, tostring(code))
  elseif payload.signal and payload.signal ~= 0 then
    msg = string.format('s2s %s: killed by signal %s', tostring(action), tostring(payload.signal))
  else
    msg = string.format('s2s %s failed (exit %s)', tostring(action), tostring(code))
  end

  local tail = first_line(payload.stderr)
  if tail and not msg:find(tail, 1, true) then
    msg = msg .. ' — ' .. tail
  end

  notify(msg, (code == 2 and not payload.parse_error) and levels.WARN or levels.ERROR, {
    id = id_for(buf, action),
    replace = true,
    title = 's2s',
  })
end

--- One INFO/WARN/ERROR line from the plugin itself (no spawn involved).
---@param msg string
---@param level integer|nil
function M.notify(msg, level)
  notify(msg, level or levels.INFO, { title = 's2s' })
end

function M.warn(msg)
  notify(msg, levels.WARN, { title = 's2s' })
end

function M.error(msg)
  notify(msg, levels.ERROR, { title = 's2s' })
end

local function fallback_report(result)
  local out = {}
  if type(result) ~= 'table' then
    return out
  end
  local keys = {}
  for k, v in pairs(result) do
    if (type(v) == 'string' or type(v) == 'number' or type(v) == 'boolean') and k ~= 'action' then
      keys[#keys + 1] = k
    end
  end
  table.sort(keys)
  for _, k in ipairs(keys) do
    out[#out + 1] = string.format('%s : %s', k, tostring(result[k]))
  end
  return out
end

local function detail_lines(entry)
  local result = entry.result
  local lines = {}

  local head = string.format('s2s %s · exit %s', tostring(entry.action), tostring(entry.code))
  if entry.ms then
    head = head .. ' · ' .. string.format('%dms', entry.ms)
  end
  if entry.at then
    head = head .. ' · ' .. os.date('%H:%M:%S', entry.at)
  end
  lines[#lines + 1] = head
  if type(entry.link) == 'table' and type(entry.link.url) == 'string' then
    lines[#lines + 1] = string.format('%s : %s', LINK_LABEL[entry.action] or 'link', entry.link.url)
  end

  local body = call('report', result)
  if type(body) ~= 'table' or #body == 0 then
    body = fallback_report(result)
  end
  for i = 1, #body do
    lines[#lines + 1] = tostring(body[i])
  end

  -- Raw capture: only when the plugin could not read a result envelope, which
  -- is exactly when somebody needs to see what the binary actually printed.
  if type(entry.raw_stdout) == 'string' and entry.raw_stdout ~= '' and #body == 0 then
    lines[#lines + 1] = string.format('--- stdout (%d bytes) ---', #entry.raw_stdout)
    local shown = 0
    for line in entry.raw_stdout:gmatch('[^\r\n]+') do
      if shown >= 12 then
        lines[#lines + 1] = '…'
        break
      end
      lines[#lines + 1] = line
      shown = shown + 1
    end
  end
  if entry.dump then
    lines[#lines + 1] = 'raw dump: ' .. tostring(entry.dump)
  end

  lines[#lines + 1] = ''
  lines[#lines + 1] = 'q: close   y: copy value'
  return lines
end

local function yank_value()
  local line = api.nvim_get_current_line()
  local value = line:match('^%s*[%w_.%-]+%s*:%s*(.+)$') or line
  pcall(vim.fn.setreg, '+', vim.trim(value))
  pcall(vim.notify, 's2s: copied ' .. vim.trim(value), levels.INFO, { title = 's2s' })
end

--- Float with the full known set + pass-through extras. q closes.
---@param buf integer|nil
---@return boolean opened
function M.detail(buf)
  buf = (buf and buf > 0) and buf or api.nvim_get_current_buf()
  local entry = require('s2s.state').get(buf)
  if not entry then
    M.notify('s2s: no result for this buffer yet', levels.INFO)
    return false
  end
  if type(entry.result) ~= 'table' and type(entry.raw_stdout) ~= 'string' then
    M.notify('s2s: no result for this buffer yet', levels.INFO)
    return false
  end

  local lines = detail_lines(entry)
  local width = 40
  for _, line in ipairs(lines) do
    width = math.max(width, vim.fn.strdisplaywidth(line) + 2)
  end
  width = math.min(width, math.max(20, vim.o.columns - 4))
  local height = math.min(#lines, math.max(4, vim.o.lines - 6))

  local ok, win = pcall(function()
    local fb = api.nvim_create_buf(false, true)
    api.nvim_buf_set_lines(fb, 0, -1, false, lines)
    vim.bo[fb].modifiable = false
    vim.bo[fb].bufhidden = 'wipe'
    vim.bo[fb].filetype = 's2s'

    local w = api.nvim_open_win(fb, true, {
      relative = 'editor',
      style = 'minimal',
      border = 'rounded',
      title = string.format(' s2s %s ', tostring(entry.action)),
      row = math.max(1, math.floor((vim.o.lines - height) / 2) - 1),
      col = math.max(1, math.floor((vim.o.columns - width) / 2)),
      width = width,
      height = height,
    })

    local function close()
      if api.nvim_win_is_valid(w) then
        api.nvim_win_close(w, true)
      end
    end
    for _, key in ipairs({ 'q', '<Esc>', '<C-c>' }) do
      vim.keymap.set('n', key, close, { buffer = fb, nowait = true, silent = true })
    end
    vim.keymap.set('n', 'y', yank_value, { buffer = fb, nowait = true, silent = true })
    return w
  end)

  if not ok then
    M.error('s2s: could not open the result float — ' .. tostring(win))
    return false
  end
  return true
end

return M

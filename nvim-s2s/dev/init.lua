-- Minimal test config for nvim-s2s: load this checkout, nothing else.
--
--   nvim -u /home/joera/code/wt-nvim-core/nvim-s2s/dev/init.lua some-note.md
--
-- This exists because a plugin manager (lazy.nvim) rebuilds the runtimepath
-- during startup, so `--cmd "set rtp+=..."` does not survive. A `-u` config is
-- read *before* plugins are sourced, so the prepend sticks.

local this = debug.getinfo(1, 'S').source:sub(2)
local root = vim.fn.fnamemodify(this, ':h:h') -- dev/init.lua -> nvim-s2s/

vim.opt.runtimepath:prepend(root)
vim.opt.number = true
vim.opt.signcolumn = 'yes'
vim.opt.laststatus = 2

-- setup() is optional (s2s on PATH works), but call it so the resolved binary
-- and the defaults are visible in :S2S help.
local ok, err = pcall(function()
  require('s2s').setup({ open = false })
end)
if not ok then
  vim.notify('nvim-s2s: setup failed — ' .. tostring(err), vim.log.levels.ERROR)
end

vim.keymap.set('n', '<leader>su', '<Plug>(s2s_upload)', { desc = 's2s upload' })
vim.keymap.set('n', '<leader>sl', '<Plug>(s2s_last)', { desc = 's2s last result' })

" nvim-s2s — plugin entry point.
"
" One interface: `:S2S <action> [args]`, with `s2s` expanding to `S2S` on the
" command line (a user command must start with an uppercase letter).
"
" No default keymaps: map your leader at <Plug>(s2s_*).

if exists('g:loaded_s2s')
  finish
endif
let g:loaded_s2s = 1

" Defining commands is all this does; nothing spawns until one runs.
call luaeval('require("s2s.commands").define()')
call luaeval('require("s2s.commands").set_abbrev(_A)', v:true)

nnoremap <silent> <Plug>(s2s_upload)  <Cmd>S2S upload<CR>
nnoremap <silent> <Plug>(s2s_propose) <Cmd>S2S propose<CR>
nnoremap <silent> <Plug>(s2s_preview) <Cmd>S2S preview<CR>
nnoremap <silent> <Plug>(s2s_publish) <Cmd>S2S publish<CR>
nnoremap <silent> <Plug>(s2s_revoke)  <Cmd>S2S revoke<CR>
nnoremap <silent> <Plug>(s2s_new)     <Cmd>S2S new<CR>
nnoremap <silent> <Plug>(s2s_config)  <Cmd>S2S config<CR>
nnoremap <silent> <Plug>(s2s_last)    <Cmd>S2S last<CR>
nnoremap <silent> <Plug>(s2s_detail)  <Cmd>S2S last<CR>
nnoremap <silent> <Plug>(s2s_health)  <Cmd>S2S health<CR>
nnoremap <silent> <Plug>(s2s_help)    <Cmd>S2S help<CR>

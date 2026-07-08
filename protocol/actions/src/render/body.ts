// body.ts — body retrieval helpers
// The main render path in render/main.ts calls fetchById(genesis, publicationModule)
// from libs/module.factory directly, so this file is kept as a marker for any
// future body-retrieval utilities.
//
// Old implementation (lens.factory.fetchById):
//   return await fetchById(id)
// New implementation uses module.factory:
//   return await fetchById(genesis, publicationModule)
// where genesis comes from the prep step (already resolved from the module).

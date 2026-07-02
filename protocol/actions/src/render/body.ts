import { fetchById } from "../libs/lens.factory";

export const getBody = async (id: string, slug: string = "") => {
  
//   return JSON.parse(await LitActions.runOnce({
//         waitForResponse: true,
//         name: `body-${slug}${id.slice(0,4)}`
//     }, async () => { 
        return await fetchById(id)
    // }));
}
const POKEAPI_URL = "https://pokeapi.co/api/v2/pokemon";

export async function getPokemon(pokemonId) {
    const pokemon = await fetch(`${POKEAPI_URL}/${pokemonId}`);
    const data = await pokemon.json();
    return data;
}

export async function getPokemons() {
    const pokemons = await fetch(`${POKEAPI_URL}?limit=151`);
    const data = await pokemons.json();

    // Parse the pokemons id from the url and add it to the results
    return data.results.map((pokemon) => ({
        ...pokemon,
        id: pokemon.url.split("/").at(-2),
    }));
}
const POKEAPI_URL = "https://pokeapi.co/api/v2";

export async function getPokemon(pokemonId) {
    const pokemon = await fetch(`${POKEAPI_URL}/pokemon/${pokemonId}`);
    const data = await pokemon.json();
    return data;
}

export async function getPokemons() {
    const pokemons = await fetch(`${POKEAPI_URL}/pokedex/1/?limit=151`);
    const data = await pokemons.json();

    // Parse the pokemons id from the url and add it to the results
    return data.pokemon_entries.map((pokemon) => ({
        id: pokemon.entry_number,
        name: pokemon.pokemon_species.name,
        species_url: pokemon.pokemon_species.url,
    }));
}
import { queryClient } from "./queryClient";

const POKEAPI_URL = "https://pokeapi.co/api/v2";

async function fetchPokemon(pokemonId) {
    // Fetch the pokemon data
    const pokemonResponse = await fetch(`${POKEAPI_URL}/pokemon/${pokemonId}`);
    const pokemon = await pokemonResponse.json();
    // Fetch the pokemon's species data
    const speciesResponse = await fetch(pokemon.species.url);
    const species = await speciesResponse.json();

    // Combine the pokemon and species data
    return { ...pokemon, ...species };
}

export async function getPokemon(pokemonId) {
    const pokemon = await queryClient.ensureQueryData({
        queryKey: ['pokemon', pokemonId],
        queryFn: () => fetchPokemon(pokemonId),
    });
    return pokemon;
}

export async function getPokedex(pokedexId) {
    const pokedex = await queryClient.ensureQueryData({
        queryKey: ['pokedex', pokedexId],
        queryFn: async () => {
            const response = await fetch(`${POKEAPI_URL}/pokedex/${pokedexId}`);
            return await response.json();
        },
    });

    return pokedex.pokemon_entries.map((pokemon) => ({
        id: pokemon.entry_number,
        name: pokemon.pokemon_species.name,
        species_url: pokemon.pokemon_species.url,
    }));
}
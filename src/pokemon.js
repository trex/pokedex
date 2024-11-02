import { queryClient } from "./queryClient";

const POKEAPI_URL = "https://pokeapi.co/api/v2";

export async function getPokemon(pokemonId) {
    const pokemon = await queryClient.ensureQueryData({
        queryKey: ['pokemon', pokemonId],
        queryFn: async () => {
            const response = await fetch(`${POKEAPI_URL}/pokemon/${pokemonId}`);
            return await response.json();
        },
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
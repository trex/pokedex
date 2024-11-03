import { queryClient } from "./queryClient";

const POKEAPI_URL = "https://pokeapi.co/api/v2";

async function fetchPokemon(pokemonId) {
    // Fetch the pokemon data
    const pokemonResponse = await fetch(`${POKEAPI_URL}/pokemon/${pokemonId}`);
    const pokemon = await pokemonResponse.json();
    // Fetch the pokemon's species data
    const speciesResponse = await fetch(pokemon.species.url);
    const species = await speciesResponse.json();
    // Fetch the pokemon's evolution chain
    const evolutionChainResponse = await fetch(species.evolution_chain.url);
    const evolutionChain = await evolutionChainResponse.json();

    // Return only the pokemon data we need in app
    return { 
        id: pokemon.id,
        name: pokemon.name,
        color: species.color.name,
        types: pokemon.types.map((type) => type.type.name),
        stats: {hp: pokemon.stats[0].base_stat},
        evolutionChain: flattenEvolutionChainToList(evolutionChain.chain),
        artwork: {front_default: pokemon.sprites.other["official-artwork"].front_default},
        genera: species.genera.find((genus) => genus.language.name === "en").genus,
        height: pokemon.height,
        weight: pokemon.weight,
        description: species.flavor_text_entries.find((entry) => entry.language.name === "en").flavor_text,
        abilities: pokemon.abilities.map((ability) => ability.ability.name),
        moves: pokemon.moves.map((move) => move.move.name),
    };
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

// ---------------------------------------------------------------------------- 
// Helper functions
// ----------------------------------------------------------------------------

// Function to flatten the evolution chain into a list of related Pokémon objects
function flattenEvolutionChainToList(chain) {
    // Helper function to extract ID from the URL
    function extractIdFromUrl(url) {
      const segments = url.split('/');
      return parseInt(segments[segments.length - 2]);
    }
  
    // Recursive function to process each evolution node
    function processEvolution(evolution, parentId = null) {
      const { name, url } = evolution.species;
      const id = extractIdFromUrl(url);
  
      // Initialize the Pokémon object with id, name, and relationships
      const pokemonEntry = {
        id,
        name,
        parentId,
        childIds: []
      };
  
      // Process each evolution and add its ID to childIds
      for (const nextEvolution of evolution.evolves_to) {
        const childPokemon = processEvolution(nextEvolution, id);
        pokemonEntry.childIds.push(childPokemon.id);
        result.push(childPokemon);
      }
  
      return pokemonEntry;
    }
  
    // Result array to store each Pokémon entry in the list format
    const result = [];
  
    // Start processing from the base of the chain
    result.push(processEvolution(chain));
  
    return result;
}

// Function to find the Pokémon that the given Pokémon evolves from
export function getEvolutionFrom(pokemonId, evolutionList) {
    const pokemon = evolutionList.find(p => p.id === pokemonId);
    if (!pokemon || pokemon.parentId === null) {
      return null; // No evolution from if parentId is null or Pokémon not found
    }
    return evolutionList.find(p => p.id === pokemon.parentId);
}
  
  // Function to find the list of Pokémon that the given Pokémon evolves to
export function getEvolutionTo(pokemonId, evolutionList) {
    const pokemon = evolutionList.find(p => p.id === pokemonId);
    if (!pokemon) {
      return []; // Return an empty array if Pokémon not found
    }
    return evolutionList.filter(p => pokemon.childIds.includes(p.id));
}
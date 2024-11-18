import { queryClient } from "./queryClient";

const POKEAPI_URL = "https://pokeapi.co/api/v2";

// Add interfaces for the API responses and our data structures
interface FlavorTextEntry {
  language: { name: string };
  flavor_text: string;
}

interface PokemonGenus {
  language: { name: string };
  name: string;
}

interface PokemonType {
  id: number;
  type: { name: string };
}

interface PokemonAbility {
  ability: { name: string };
}

interface PokemonMove {
  move: { name: string };
}

interface Pokemon {
  id: number;
  name: string;
  color: string;
  types: PokemonType[];
  stats: { hp: number };
  evolutionChain: PokemonNode;
  artwork: { front_default: string };
  genera: PokemonGenus;
  height: number;
  weight: number;
  description: string;
  abilities: PokemonAbility[];
  moves: PokemonMove[];
}

interface PokedexEntry {
  entry_number: number;
  name: string;
  species_url: string;
  pokemon_species: {
    name: string;
    url: string;
  };
}

interface PokedexResponse {
  pokemon: PokedexEntry[];
  name: string;
}

interface EvolutionRequirement {
  trigger: string;
  minLevel?: number;
  item?: string;
  location?: string;
  otherConditions: string[];
}

interface PokemonNode {
  nodeId: number;
  pokemonId: number | null;
  name: string;
  evolvesTo: Evolution[];
}

interface Evolution {
  pokemon: PokemonNode;
  requirement: EvolutionRequirement;
}

async function fetchPokemon(pokemonId: number | string): Promise<Pokemon> {
    // Fetch the pokemon data
    const pokemonResponse = await fetch(`${POKEAPI_URL}/pokemon/${pokemonId}`);
    const pokemon = await pokemonResponse.json();
    // Fetch the pokemon's species data
    const speciesResponse = await fetch(pokemon.species.url);
    const species = await speciesResponse.json();
    // Fetch the pokemon's evolution chain
    const evolutionChainResponse = await fetch(species.evolution_chain.url);
    const evolutionChain = await evolutionChainResponse.json();

    // Add await here
    const evolutionData = await getEvolutionChain(pokemon.name);
    if (!evolutionData) throw new Error("Failed to fetch evolution chain");

    // Replace random � characters returned by PokeAPI with a space
    const speciesDescription = species.flavor_text_entries.find((entry: FlavorTextEntry) => entry.language.name === "en").flavor_text
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' '); // Replaces non-printable characters
    
        // Return only the pokemon data we need in app
    return { 
        id: pokemon.id,
        name: pokemon.name,
        color: species.color.name,
        types: pokemon.types.map((type: PokemonType) => type.type.name),
        stats: {hp: pokemon.stats[0].base_stat},
        evolutionChain: evolutionData,
        artwork: {front_default: pokemon.sprites.other["official-artwork"].front_default},
        genera: species.genera.find((genus: PokemonGenus) => genus.language.name === "en").genus,
        height: pokemon.height,
        weight: pokemon.weight,
        description: speciesDescription,
        abilities: pokemon.abilities.map((ability: PokemonAbility) => ability.ability.name),
        moves: pokemon.moves.map((move: PokemonMove) => move.move.name),
    };
}

export async function getPokemon(pokemonId: number | string): Promise<Pokemon> {
    const pokemon = await queryClient.ensureQueryData({
        queryKey: ['pokemon', pokemonId],
        queryFn: () => fetchPokemon(pokemonId),
    });
    return pokemon;
}

export async function getPokedex(pokedexId: number | string): Promise<PokedexResponse> {
    const pokedex = await queryClient.ensureQueryData({
        queryKey: ['pokedex', pokedexId],
        queryFn: async () => {
            const response = await fetch(`${POKEAPI_URL}/pokedex/${pokedexId}`);
            return await response.json();
        },
    });

    return {
      pokemon: pokedex.pokemon_entries.map((pokemon: PokedexEntry) => ({
        id: pokemon.entry_number,
        name: pokemon.pokemon_species.name,
        species_url: pokemon.pokemon_species.url,
      })),
    name: pokedex.name,
  };
}

// Helper function to get evolution chain by Pokémon name
async function getEvolutionChain(pokemonName: string): Promise<PokemonNode | null> {
  try {
    // Step 1: Get Pokémon species to retrieve the evolution chain URL
    const speciesResponse = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${pokemonName}`);
    if (!speciesResponse.ok) throw new Error("Failed to fetch Pokémon species");
    const speciesData = await speciesResponse.json();
    const evolutionChainUrl = speciesData.evolution_chain.url;

    // Step 2: Fetch the evolution chain data
    const evolutionResponse = await fetch(evolutionChainUrl);
    if (!evolutionResponse.ok) throw new Error("Failed to fetch evolution chain");
    const evolutionData = await evolutionResponse.json();
    const evolutionChain = evolutionData.chain;

    let nodeId = 0;
    // Step 3: Recursively parse the evolution chain data into the PokemonNode structure
    const parseChain = (evolutionNode: any, nodeId: number): PokemonNode => {
      // Create the base Pokémon node
      const currentPokemon: PokemonNode = {
        nodeId: nodeId,
        pokemonId: getIdFromUrl(evolutionNode.species.url),
        name: evolutionNode.species.name,
        evolvesTo: [],
      };

      // Process each evolution in the chain
      evolutionNode.evolves_to.forEach((evolution: any) => {
        const requirement: EvolutionRequirement = {
          trigger: evolution.evolution_details[0].trigger.name,
          minLevel: evolution.evolution_details[0].min_level || undefined,
          item: evolution.evolution_details[0].item?.name || undefined,
          location: evolution.evolution_details[0].location?.name || undefined,
          otherConditions: [],
        };

        // Add other conditions if applicable
        if (evolution.evolution_details[0].held_item) {
          requirement.otherConditions.push(`Held item: ${evolution.evolution_details[0].held_item.name}`);
        }
        if (evolution.evolution_details[0].known_move) {
          requirement.otherConditions.push(`Known move: ${evolution.evolution_details[0].known_move.name}`);
        }
        if (evolution.evolution_details[0].time_of_day) {
          requirement.otherConditions.push(`Time of day: ${evolution.evolution_details[0].time_of_day}`);
        }

        nodeId += 1;
        // Recursively parse the next evolution stage
        currentPokemon.evolvesTo.push({
          pokemon: parseChain(evolution, nodeId),
          requirement,
        });
      });

      return currentPokemon;
    };

    // Return the parsed evolution tree starting from the base Pokémon
    return parseChain(evolutionChain, nodeId);
  } catch (error) {
    console.error("Error fetching evolution chain:", error);
    return null;
  }
}

function getIdFromUrl(url: string): number | null {
  // Use a regular expression to match the digits at the end of the URL
  const match = url.match(/\/(\d+)\/?$/);
  // If a match is found, return the captured group as a number
  return match ? parseInt(match[1], 10) : null;
}
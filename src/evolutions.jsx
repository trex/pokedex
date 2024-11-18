import { NavLink } from "react-router-dom";
// Get the base URL from Vite's env
const base = import.meta.env.BASE_URL;
const NOT_FOUND = "This pokemon does not evolve."

export default function Evolutions({ targetPokemon, evolutionChain }) {
    const pokemonsEvolutions = filterPokemonEvolutions(targetPokemon, evolutionChain);
    if (pokemonsEvolutions.length === 0) {
        return (
            <div className="pokemon-evolution-not-found">{NOT_FOUND}</div>
        );    
    }

    return (
        <div className="pokemon-evolutions">
            {pokemonsEvolutions.map((evolution) => 
                buildChildNode(evolution))}
        </div>
    );
}

function buildChildNode(evolution){
    return (
        <NavLink key={evolution.id} to={`/pokemon/${evolution.id}`}>
            <div key={evolution.id} className="evolution-child pokeball">
                <img className="pokemon-evolution-sprite" src={`${base}/pokemon_sprites/front_default/${evolution.id}.png`} alt={`${evolution.name} evolution sprite`} />
                <p className="pokemon-evolution-name">{evolution.name}</p>
            </div>
        </NavLink>
    );
}

function filterPokemonEvolutions(targetPokemon, evolutionChain){
    if (evolutionChain.name === targetPokemon) {
      const evolutions = (evolutionChain.evolvesTo.length > 0) ? evolutionChain.evolvesTo.map((evolution) => {
        return {
            id: evolution.pokemon.pokemonId,
            name: evolution.pokemon.name   
        }
      }) : [];
      return evolutions;
    }
  
    for (let i=0; i < evolutionChain.evolvesTo.length; i++) {
        const currentEvolution = evolutionChain.evolvesTo[i].pokemon;
        return filterPokemonEvolutions(targetPokemon, currentEvolution);
    }
    // Traversed the whole chain and this pokemon does not evolve
    return [];
}
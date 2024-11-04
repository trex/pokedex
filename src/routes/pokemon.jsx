import { useLoaderData, useOutletContext } from "react-router-dom";
import { getPokemon, getEvolutionFrom, getEvolutionTo } from "../pokemon";
import { useState } from "react";

export async function loader({ params }) {
    const pokemon = await getPokemon(params.pokemonId);
    return { pokemon };
}

export default function Pokemon() {
    const { pokemon } = useLoaderData();
    const primaryType = pokemon.types[0];
    const { heightUnit, weightUnit } = useOutletContext();
    const [selectedSection, setSelectedSection] = useState('evolution');

    const sections = {
        evolution: {
            title: "Evolutions",
            content: (
                <div className="evolution-chain">
                    {getEvolutionTo(pokemon.id, pokemon.evolutionChain).map((stage) => (
                        <div key={stage.id} className="evolution-stage">
                            <span className="evolution-name">{stage.name}</span>
                        </div>
                    ))}
                </div>
            )
        },
        abilities: {
            title: "Abilities",
            content: (
                <div className="abilities-list">
                    {pokemon.abilities.map((abilityName) => (
                        <span key={abilityName} className="ability-badge">
                            {abilityName}
                        </span>
                    ))}
                </div>
            )
        },
        moves: {
            title: "Moves",
            content: (
                <div className="moves-list">
                    {pokemon.moves.slice(0, 4).map((moveName) => (
                        <span key={moveName} className="move-badge">
                            {moveName}
                        </span>
                    ))}
                </div>
            )
        }
    };

    return (
        <div 
            className="pokemon-card" 
            style={{ "--pokemon-color": pokemon.color }} 
            data-type={primaryType}
        >
            <div className="card-header">
                <div className="card-header-left">
                    <img src="../stage-2.png" alt="basic" className="stage-icon" />
                    <h1 className="pokemon-name">{pokemon.name}</h1>
                </div>
                <div className="card-header-right">
                    <div className="pokemon-hp">
                        <span className="hp-label">HP</span><span className="hp-value">{pokemon.stats.hp}</span>
                    </div>
                    <div className="types">
                        {pokemon.types.map((typeName) => (
                            <img 
                                key={typeName} 
                                src={`../type-icons/${typeName}.png`} 
                                className="type-badge"
                                alt={`${typeName} type`} 
                            />
                        ))}
                    </div>
                </div>
            </div>
            
            <div className="card-body">
                <div className="pokemon-image-container" data-type={primaryType}>
                    <img src={pokemon.artwork.front_default} alt={pokemon.name} className="pokemon-image" />
                    <div className="info-row">
                        <span className="pokemon-number">No. {pokemon.id}</span>
                        <span className="genus">{pokemon.genera}</span>
                        <span>Height: {heightUnit.conversion(pokemon.height)} {heightUnit.abreviation}</span>
                        <span>Weight: {weightUnit.conversion(pokemon.weight)} {weightUnit.abreviation}</span> 
                    </div>
                </div>
                
                <div className="pokemon-info">
                    <div className="pokemon-description">
                        {pokemon.description}
                    </div>

                    <div className="info-selector">
                        <select 
                            value={selectedSection}
                            onChange={(e) => setSelectedSection(e.target.value)}
                            className="section-select"
                        >
                            {Object.entries(sections).map(([key, { title }]) => (
                                <option key={key} value={key}>{title}</option>
                            ))}
                        </select>

                        <div className="section-content">
                            {sections[selectedSection].content}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
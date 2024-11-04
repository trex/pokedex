export default function NavButton({ open, setOpen }) {
    return (
        <div 
        className={`nav-button nav-${open ? 'open' : 'closed'}`} 
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close nav" : "Open nav"}
        >
            <div className="bar1"></div>
            <div className="bar2"></div>
            <div className="bar3"></div>
        </div>
    );
}
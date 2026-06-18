export const typograhyStylestring = `
    
    body, p, div {
        font-weight: 400;
        line-height: 1.55;
    }

    h1 {

        font-size: 3.2rem;
        font-family: "Knockout 50 A", "Knockout 50 B";
        font-style: normal;
        font-weight: 400;
    }

    h2 {

        font-family: "Ringside Regular Office A", "Ringside Regular Office B";
        font-style: normal;
        font-weight: 700;
    }

    *, p {
        font-family: "Operator Mono A", "Operator Mono B";
        font-style: normal;
        font-weight: 400;
        font-size: 1rem;
        line-height: 1.55;
    }
`

export const typograhyStyles = new CSSStyleSheet();
typograhyStyles.replaceSync(typograhyStylestring);